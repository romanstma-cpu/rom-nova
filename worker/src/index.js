#!/usr/bin/env node
// ROM Nova Radar — the autonomous whale scanner.
//
// Boot order: config → database (hydrate scores from journaled fills) →
// HTTP/socket feed → the two keyless streams (PumpPortal creations,
// publicnode program logs) → optional Helius off-curve coverage. Everything
// after boot is event-driven; the only clocks are flush ticks, heartbeats,
// the grader's stale-mark tick and the leaderboard push.

import { HeliusStream } from "../../src/lib/radar/engine/helius.js";
import { lookupSolPrices, lookupStatus } from "../../src/lib/radar/engine/pricelookup.js";
import { startPumpPortal } from "../../src/lib/radar/engine/pumpportal.js";
import { startRpcStream } from "../../src/lib/radar/engine/rpcstream.js";
import { RadarState } from "../../src/lib/radar/engine/state.js";
import { log, short } from "../../src/lib/radar/engine/util.js";
import { Access } from "./access.js";
import { Api } from "./api.js";
import { ApiKeys, RateLimiter } from "./apikeys.js";
import { AuthVerifier } from "./auth.js";
import { Billing } from "./billing.js";
import { loadConfig } from "./config.js";
import { Db, HORIZON_COLUMN } from "./db.js";
import { dexScreenerLookup, dexScreenerStatus } from "./dexscreener.js";
import { Feed } from "./io.js";

const startedAt = Date.now();
const cfg = loadConfig();
log("radar starting", JSON.stringify({ dryRun: cfg.dryRun, gates: cfg.gates, port: cfg.port, access: cfg.access }));

const db = new Db(cfg);
await db.connect();

// The gate and the desk. In open mode the verifier is null and Access lets
// everything through; the routes still answer, saying so.
const verifier =
  cfg.access === "open"
    ? null
    : new AuthVerifier({ supabaseUrl: cfg.supabaseUrl, apiKey: cfg.supabaseServiceKey || cfg.supabaseAnonKey });
const apiKeys = new ApiKeys(db, { maxPerUser: cfg.apiKeysPerUser });
const access = new Access(cfg, { verifier, db, apiKeys });
const billing = new Billing(cfg, db, { onApplied: (userId) => access.forget(userId) });
if (cfg.access === "subscription") await billing.loadPrice();

/** @type {Feed} */
let feed; // assigned before any stream starts; statusFn closes over the box

const state = new RadarState(cfg.gates, cfg.maxTracked, onEffect);
const helius = new HeliusStream(
  cfg,
  () => state.top(cfg.heliusWalletSubs).map((w) => w.wallet_address),
  (t) => state.onTrade(t),
);

function status() {
  return {
    ok: true,
    service: "rom-nova-radar",
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    dry_run: cfg.dryRun,
    gates: cfg.gates,
    counts: { ...state.counts, tracked: state.tracked.size, clients: feed?.clients ?? 0 },
    streams: {
      pumpportal: pump?.status() ?? null,
      rpc_logs: rpc?.status() ?? null,
      helius: helius.status(),
    },
    db: db.status(),
    access: { ...access.status(), sockets: feed?.counts ?? null },
    billing: billing.status(),
    api: api.status(),
    dexscreener: dexScreenerStatus(),
    price_lookup: lookupStatus(),
    coverage:
      "pump.fun bonding-curve trades, program-wide" +
      (helius.enabled ? ", plus Helius off-curve coverage for top wallets" : " — off-curve trades are NOT observed (set HELIUS_API_KEY to extend)"),
  };
}

// The HTTP API reads the feed's rings and the state's wallets on demand;
// the closures resolve at request time, after `feed` exists.
const api = new Api({
  cfg,
  access,
  apiKeys,
  limiter: new RateLimiter({ perMinute: cfg.apiRatePerMinute }),
  db,
  data: {
    rings: () => feed.rings,
    topWallets: (n) => state.top(n),
    wallet: (address) => {
      const w = state.tracked.get(address);
      return w ? state.rowOf(address, w) : null;
    },
  },
});
feed = new Feed(cfg, status, { access, billing, api });

/** A grade, as the columns it lands in. */
function outcomePatch(e) {
  const patch = { [HORIZON_COLUMN[e.horizon]]: e.ret, peak_ret_1h: e.peak_ret };
  if (e.stale) patch.graded_stale = true;
  if (e.source === "lookup") patch.graded_lookup = true;
  return patch;
}

// Marks the stream cannot give: a horizon that passed with no trade since
// (the token left the curve, or died) gets a DexScreener quote before the
// tick would mark it stale. Capped batch, one call at a time.
const LOOKUP_EVERY_MS = 10_000;
let lookupBusy = false;
let lastLookupAt = 0;
async function gradeTick() {
  const now = Date.now();
  if (!lookupBusy && now - lastLookupAt >= LOOKUP_EVERY_MS) {
    const wanted = state.marksWanted(now);
    if (wanted.length > 0) {
      lookupBusy = true;
      lastLookupAt = now;
      try {
        const marks = await lookupSolPrices(wanted);
        for (const [mint, m] of marks) state.markExternal(mint, m.priceSol, m.at);
      } finally {
        lookupBusy = false;
      }
    }
  }
  state.tick(Date.now());
}

/** Effects out of the pipeline, fanned to the database and the feed. */
function onEffect(e) {
  switch (e.kind) {
    case "launch":
      db.addLaunch(e.launch);
      feed.push("launches", "launch", e.launch);
      return;
    case "whale":
      feed.push("whales", "whale_seen", e);
      log(`WHALE ${short(e.wallet)} bought ${e.sol.toFixed(2)} SOL of ${short(e.mint)} ${e.launchAgeMs !== null ? Math.round(e.launchAgeMs / 1000) + "s" : "?"} after launch — tracking`);
      return;
    case "trade":
      db.addTrade(e.trade);
      feed.push("trades", "trade", e.trade);
      return;
    case "wallet":
      db.addWallet(e.row);
      feed.walletUpdate(e.row);
      return;
    case "signal":
      emitSignal(e).catch((err) => log("[signal] enrich failed:", err?.message ?? err));
      return;
    case "signal_outcome": {
      const patch = outcomePatch(e);
      db.patchSignal(e.signal_key, patch);
      feed.patchSignal(e.signal_key, patch);
      feed.io.emit("signal_outcome", e);
      if (e.horizon === "m5") log(`GRADE ${short(e.wallet)} on ${short(e.mint)}: +5m ${(e.ret * 100).toFixed(0)}%${e.stale ? " (stale)" : ""}`);
      return;
    }
    case "behaviour":
      feed.push("behaviours", "behaviour", e);
      if (e.behaviour === "dormant_buy" || e.behaviour === "wash_like") log(`BEHAVIOUR ${e.behaviour} ${short(e.wallet)} on ${short(e.mint)}`);
      return;
    case "exit": {
      if (e.first) {
        const patch = { whale_exit_ret: e.ret, whale_exit_after_ms: e.after_ms, whale_exit_fraction: e.fraction };
        db.patchSignal(e.signal_key, patch);
        feed.patchSignal(e.signal_key, patch);
        log(`EXIT ${short(e.wallet)} sold ${e.fraction === null ? "?" : Math.round(e.fraction * 100) + "%"} of ${short(e.mint)} at ${(e.ret * 100).toFixed(0)}% ${Math.round(e.after_ms / 1000)}s after its signal`);
      }
      feed.io.emit("exit", e);
      return;
    }
  }
}

/** Signals get a name before they land anywhere — own launch record first,
 * DexScreener for tokens whose launch predates this process. */
async function emitSignal(e) {
  const s = e.signal;
  if (!s.token_name) {
    const dex = await dexScreenerLookup(s.token_address);
    if (dex?.name) s.token_name = dex.name;
  }
  db.addSignal(s);
  feed.push("signals", "signal", { ...s, settled_sells: e.settledSells });
  log(`SIGNAL score ${s.wallet_score} wallet ${short(s.wallet_address)} bought ${s.buy_amount_sol} SOL of ${s.token_name ?? short(s.token_address)}`);
}

const hydrated = await db.hydrate(state);
if (hydrated.wallets > 0) log(`resuming with ${hydrated.wallets} wallets from the journal`);
if (hydrated.signals > 0) log(`resumed ${hydrated.signals} signals: ${hydrated.grades} grades replayed, ${hydrated.watching} still grading or awaiting an exit`);

db.start();
feed.start();
const pump = startPumpPortal(cfg, (launch, at) => state.onLaunch(launch, at));
const rpc = startRpcStream(cfg, (t) => state.onTrade(t));
helius.start();

// The grader's clock: off-curve quotes first, then horizons nothing will
// ever mark, and exit watches past their day.
setInterval(() => {
  gradeTick().catch((err) => log("[grade] tick failed:", err?.message ?? err));
}, 5_000);

// Leaderboard push: cheap, and only when something could have changed.
let lastJournaled = -1;
let lastGraded = -1;
setInterval(() => {
  if (state.counts.journaled === lastJournaled && state.counts.graded === lastGraded) return;
  lastJournaled = state.counts.journaled;
  lastGraded = state.counts.graded;
  feed.setTopWallets(state.top(10));
  feed.io.emit("leaderboard", feed.topWallets);
}, 10_000);

async function shutdown(signal) {
  log(`${signal} — flushing and closing`);
  pump.stop();
  rpc.stop();
  helius.stop();
  feed.stop();
  await db.stop();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
