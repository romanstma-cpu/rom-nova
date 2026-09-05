// The push side: one HTTP server carrying /health, the account routes and
// the Socket.io feed.
//
// Web service on purpose, not a Render "background worker": Socket.io needs
// a public port anyway, and a single process keeps the scanner and its feed
// in one memory space — the leaderboard pushed to a browser IS the map the
// gates read, no sync to drift.
//
// HTTP routes:
//   GET  /health, /        status, always public — uptime monitors need it
//   GET  /config           what the app needs to sign in: the access mode,
//                          the Supabase URL and anon key, the price
//   GET  /me               who the Bearer token is, and whether it is paid up
//   POST /billing/checkout a Stripe Checkout URL for the Bearer token's reader
//   POST /billing/portal   a Stripe Customer Portal URL, or 404 before any purchase
//   POST /billing/webhook  Stripe's deliveries, signature-checked, raw body
//
// Events a client receives on the socket (after the gate, see config.js):
//   snapshot       once on connect — recent launches/whales/signals, top
//                  wallets, status
//   launch         every creation seen
//   whale_seen     a wallet crossing the discovery gate
//   trade          every journaled tracked-wallet fill
//   signal         a proven wallet buying — the reason this worker exists
//   signal_outcome a grade for a signal: horizon, return vs the fill, peak
//   exit           the signal wallet selling — first: true is the alert
//   behaviour      a tracked wallet doing something worth a read: dormant_buy,
//                  accumulation, distribution, wash_like
//   wallet_update  a tracked wallet's row after a fill or a grade
//   leaderboard    top wallets by score, when something changed
//   status         every 30s
//   gate           this connection is about to be closed: {status, reason} —
//                  a session that expired or a subscription that lapsed
//
// The raw ~35 trades/s firehose is deliberately NOT broadcast — clients get
// the filtered planes above, which is why a phone on hotel wifi can hold
// this feed open.

import { createServer } from "node:http";
import { Server } from "socket.io";
import { log } from "../../src/lib/radar/engine/util.js";
import { BillingError, StripeError } from "./billing.js";

const RING = { launches: 60, whales: 60, trades: 120, signals: 100, behaviours: 80 };
/** Stripe events are a few KB; anything past this is not a webhook. */
const BODY_CAP = 256 * 1024;
/** How often a connected socket is re-checked against the gate. */
const SWEEP_MS = 10 * 60_000;

// A public API read from browsers on other origins, with a Bearer header —
// which is what makes the preflight necessary. No cookies anywhere, so the
// wildcard origin is safe.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-max-age": "600",
};

/** @param {import("node:http").IncomingMessage} req @param {number} cap */
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** @param {import("node:http").IncomingMessage} req */
function bearerOf(req) {
  const m = /^bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  return m ? m[1] : "";
}

export class Feed {
  /**
   * @param {import("./config.js").Config} cfg
   * @param {() => any} statusFn
   * @param {{ access?: import("./access.js").Access, billing?: import("./billing.js").Billing }} [deps]
   */
  constructor(cfg, statusFn, deps = {}) {
    this.cfg = cfg;
    this.statusFn = statusFn;
    this.access = deps.access ?? null;
    this.billing = deps.billing ?? null;
    this.rings = { launches: [], whales: [], trades: [], signals: [], behaviours: [] };
    this.topWallets = [];
    this.clients = 0;
    this.counts = { requests: 0, gated_sockets: 0, swept: 0 };

    this.http = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log("[io] request failed:", err?.message ?? err);
        if (!res.headersSent) this.json(res, 500, { error: "internal error" });
        else res.end();
      });
    });

    this.io = new Server(this.http, {
      cors: { origin: "*" }, // no cookies, no credentials: the token travels in the handshake's auth payload
      serveClient: false,
    });

    // The gate, at the handshake. A refused connection reaches the client
    // as connect_error with err.data.status, which the app keys on.
    this.io.use((socket, next) => {
      if (!this.access) return next();
      const token = socket.handshake.auth?.token;
      this.access
        .check(typeof token === "string" ? token : "")
        .then((r) => {
          if (!r.ok) {
            this.counts.gated_sockets++;
            // socket.io forwards `data` to the client's connect_error
            return next(Object.assign(new Error(r.reason), { data: { status: r.status } }));
          }
          socket.data.user = r.user;
          socket.data.token = typeof token === "string" ? token : "";
          next();
        })
        .catch(() => next(Object.assign(new Error("access check failed"), { data: { status: 503 } })));
    });

    this.io.on("connection", (socket) => {
      this.clients++;
      socket.emit("snapshot", {
        launches: this.rings.launches.slice(-30),
        whales: this.rings.whales.slice(-30),
        trades: this.rings.trades.slice(-60),
        signals: this.rings.signals.slice(-50),
        behaviours: this.rings.behaviours.slice(-40),
        wallets: this.topWallets,
        status: this.statusFn(),
      });
      socket.on("disconnect", () => {
        this.clients--;
      });
    });
  }

  /** @param {import("node:http").ServerResponse} res @param {number} status @param {any} body */
  json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json", ...CORS });
    res.end(JSON.stringify(body, null, status === 200 && body?.service ? 2 : 0));
  }

  /**
   * The route table. Socket.io claims /socket.io/ before this runs.
   * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res
   */
  async handle(req, res) {
    this.counts.requests++;
    const path = (req.url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    if (method === "GET" && (path === "/health" || path === "/")) {
      this.json(res, 200, this.statusFn());
      return;
    }

    if (method === "GET" && path === "/config") {
      this.json(res, 200, {
        access: this.cfg.access,
        auth: this.cfg.supabaseAnonKey ? { url: this.cfg.supabaseUrl, anon_key: this.cfg.supabaseAnonKey } : null,
        billing: this.billing ? this.billing.publicInfo() : { enabled: false, price: null },
        app_url: this.cfg.appUrl,
      });
      return;
    }

    if (method === "GET" && path === "/me") {
      if (!this.access || this.cfg.access === "open") {
        this.json(res, 200, { access: "open", user: null, entitled: true, subscription: null, billing_ready: false });
        return;
      }
      const who = await this.access.identify(bearerOf(req));
      if (!who.ok) {
        this.json(res, who.status, { error: who.reason });
        return;
      }
      if (this.cfg.access !== "subscription" || !who.user) {
        this.json(res, 200, { access: this.cfg.access, user: who.user, entitled: true, subscription: null, billing_ready: false });
        return;
      }
      // Fresh on purpose: this is the page the reader lands on after paying.
      const ent = this.access.db.billingReady === true ? await this.access.entitlement(who.user.id, { fresh: true }) : null;
      this.json(res, 200, {
        access: "subscription",
        user: who.user,
        entitled: ent ? ent.entitled : false,
        subscription: ent ? ent.row : null,
        billing_ready: this.access.db.billingReady === true,
      });
      return;
    }

    if (method === "POST" && path === "/billing/checkout") {
      await this.billingRoute(req, res, (user) => this.billing?.checkoutUrl(user) ?? Promise.reject(new BillingError(503, "billing is not configured on this radar")));
      return;
    }

    if (method === "POST" && path === "/billing/portal") {
      await this.billingRoute(req, res, async (user) => {
        if (!this.billing) throw new BillingError(503, "billing is not configured on this radar");
        const url = await this.billing.portalUrl(user);
        if (!url) throw new BillingError(404, "no billing record yet — subscribe first");
        return url;
      });
      return;
    }

    if (method === "POST" && path === "/billing/webhook") {
      if (!this.billing || !this.billing.enabled) {
        this.json(res, 404, { error: "billing is not configured on this radar" });
        return;
      }
      let raw;
      try {
        raw = await readBody(req, BODY_CAP);
      } catch (err) {
        this.json(res, 413, { error: err instanceof Error ? err.message : "bad body" });
        return;
      }
      const out = await this.billing.handleWebhook(raw, req.headers["stripe-signature"]);
      this.json(res, out.status, out.body);
      return;
    }

    this.json(res, 404, { error: "not found" });
  }

  /**
   * The two Stripe-session routes share a shape: identify the reader, mint
   * a URL for them, answer {url}. Errors carry their own status.
   * @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res
   * @param {(user: { id: string, email: string }) => Promise<string>} mint
   */
  async billingRoute(req, res, mint) {
    if (!this.access || this.cfg.access !== "subscription") {
      this.json(res, 404, { error: "this radar does not sell subscriptions" });
      return;
    }
    const who = await this.access.identify(bearerOf(req));
    if (!who.ok || !who.user) {
      this.json(res, who.ok ? 401 : who.status, { error: who.ok ? "sign in first" : who.reason });
      return;
    }
    try {
      const url = await mint(who.user);
      this.json(res, 200, { url });
    } catch (err) {
      if (err instanceof BillingError) this.json(res, err.status, { error: err.message });
      else if (err instanceof StripeError) this.json(res, 502, { error: `stripe: ${err.message}` });
      else throw err;
    }
  }

  start() {
    this.http.listen(this.cfg.port, () => log(`[io] listening on :${this.cfg.port} — /health + socket.io${this.access && this.cfg.access !== "open" ? ` (gate: ${this.cfg.access})` : ""}`));
    this.timer = setInterval(() => this.io.emit("status", this.statusFn()), 30_000);
    // A session that expires or a subscription that lapses mid-connection:
    // re-check every socket on a slow clock and close the ones the gate
    // would now refuse. The checks are cached, so this costs one Supabase
    // call per socket per minute at most.
    if (this.access && this.cfg.access !== "open") {
      this.sweepTimer = setInterval(() => {
        this.sweep().catch((err) => log("[io] sweep failed:", err?.message ?? err));
      }, SWEEP_MS);
    }
  }

  async sweep() {
    if (!this.access) return;
    for (const socket of await this.io.fetchSockets()) {
      const r = await this.access.check(socket.data?.token ?? "");
      if (r.ok) continue;
      this.counts.swept++;
      socket.emit("gate", { status: r.status, reason: r.reason });
      socket.disconnect(true);
    }
  }

  /** @param {"launches"|"whales"|"trades"|"signals"|"behaviours"} ring @param {string} event @param {any} payload */
  push(ring, event, payload) {
    const r = this.rings[ring];
    r.push(payload);
    if (r.length > RING[ring]) r.shift();
    this.io.emit(event, payload);
  }

  /** @param {any[]} rows */
  setTopWallets(rows) {
    this.topWallets = rows;
  }

  /**
   * Fold a grade or an exit into the signal it belongs to, so a client that
   * connects later sees the signal already graded in its snapshot.
   * @param {string} key @param {Record<string, any>} patch
   */
  patchSignal(key, patch) {
    const i = this.rings.signals.findIndex((s) => s.signal_key === key);
    if (i >= 0) this.rings.signals[i] = { ...this.rings.signals[i], ...patch };
  }

  /** @param {any} row */
  walletUpdate(row) {
    this.io.emit("wallet_update", row);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.io.close();
    this.http.close();
  }
}
