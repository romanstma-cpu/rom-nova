// The push side: one HTTP server carrying /health and the Socket.io feed.
//
// Web service on purpose, not a Render "background worker": Socket.io needs
// a public port anyway, and a single process keeps the scanner and its feed
// in one memory space — the leaderboard pushed to a browser IS the map the
// gates read, no sync to drift.
//
// Events a client receives:
//   snapshot       once on connect — recent launches/whales/signals, top
//                  wallets, status
//   launch         every creation seen
//   whale_seen     a wallet crossing the discovery gate
//   trade          every journaled tracked-wallet fill
//   signal         a proven wallet buying — the reason this worker exists
//   wallet_update  a tracked wallet's row after a fill
//   status         every 30s
//
// The raw ~35 trades/s firehose is deliberately NOT broadcast — clients get
// the filtered planes above, which is why a phone on hotel wifi can hold
// this feed open.

import { createServer } from "node:http";
import { Server } from "socket.io";
import { log } from "./util.js";

const RING = { launches: 60, whales: 60, trades: 120, signals: 100 };

export class Feed {
  /** @param {import("./config.js").Config} cfg @param {() => any} statusFn */
  constructor(cfg, statusFn) {
    this.cfg = cfg;
    this.statusFn = statusFn;
    this.rings = { launches: [], whales: [], trades: [], signals: [] };
    this.topWallets = [];
    this.clients = 0;

    this.http = createServer((req, res) => {
      if (req.url === "/health" || req.url === "/") {
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(JSON.stringify(this.statusFn(), null, 2));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    this.io = new Server(this.http, {
      cors: { origin: "*" }, // a public read-only broadcast; there is nothing to protect from an origin
      serveClient: false,
    });

    this.io.on("connection", (socket) => {
      this.clients++;
      socket.emit("snapshot", {
        launches: this.rings.launches.slice(-30),
        whales: this.rings.whales.slice(-30),
        trades: this.rings.trades.slice(-60),
        signals: this.rings.signals.slice(-50),
        wallets: this.topWallets,
        status: this.statusFn(),
      });
      socket.on("disconnect", () => {
        this.clients--;
      });
    });
  }

  start() {
    this.http.listen(this.cfg.port, () => log(`[io] listening on :${this.cfg.port} — /health + socket.io`));
    this.timer = setInterval(() => this.io.emit("status", this.statusFn()), 30_000);
  }

  /** @param {"launches"|"whales"|"trades"|"signals"} ring @param {string} event @param {any} payload */
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

  /** @param {any} row */
  walletUpdate(row) {
    this.io.emit("wallet_update", row);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.io.close();
    this.http.close();
  }
}
