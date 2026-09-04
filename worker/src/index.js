#!/usr/bin/env node
// ROM Nova Radar — the autonomous whale scanner.
//
// Boot order: config → database (hydrate scores from journaled fills) →
// HTTP/socket feed → the two keyless streams (PumpPortal creations,
// publicnode program logs) → optional Helius off-curve coverage. Everything
// after boot is event-driven; the only clocks are flush ticks, heartbeats
// and the leaderboard push.

import { HeliusStream } from "../../src/lib/radar/engine/helius.js";
import { startPumpPortal } from "../../src/lib/radar/engine/pumpportal.js";
import { startRpcStream } from "../../src/lib/radar/engine/rpcstream.js";
import { RadarState } from "../../src/lib/radar/engine/state.js";
import { log, short } from "../../src/lib/radar/engine/util.js";
import { loadConfig } from "./config.js";
import { Db } from "./db.js";
import { dexScreenerLookup, dexScreenerStatus } from "./dexscreener.js";
import { Feed } from "./io.js";

const startedAt = Date.now();
const cfg = loadConfig();
log("radar starting", JSON.stringify({ dryRun: cfg.dryRun, gates: cfg.gates, port: cfg.port }));

const db = new Db(cfg);
await db.connect();

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
    dexscreener: dexScreenerStatus(),
    coverage:
      "pump.fun bonding-curve trades, program-wide" +
      (helius.enabled ? ", plus Helius off-curve coverage for top wallets" : " — off-curve trades are NOT observed (set HELIUS_API_KEY to extend)"),
  };
}

feed = new Feed(cfg, status);

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

db.start();
feed.start();
const pump = startPumpPortal(cfg, (launch, at) => state.onLaunch(launch, at));
const rpc = startRpcStream(cfg, (t) => state.onTrade(t));
helius.start();

// Leaderboard push: cheap, and only when something could have changed.
let lastJournaled = -1;
setInterval(() => {
  if (state.counts.journaled === lastJournaled) return;
  lastJournaled = state.counts.journaled;
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
