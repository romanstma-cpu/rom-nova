// Every knob the worker has, read once at boot. Values come from the
// environment only — this file must never contain a key, and neither may any
// other. The operator pastes keys into Render's dashboard or a local .env
// they keep to themselves.

/** @param {string} name @param {number} dflt */
function num(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} is not a number: "${raw}"`);
  return v;
}

export function loadConfig() {
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY ?? "";
  if (!dryRun && (!supabaseUrl || !supabaseServiceKey)) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_KEY are required (or set DRY_RUN=1 to run with an in-memory store).",
    );
  }

  return {
    dryRun,
    supabaseUrl,
    supabaseServiceKey,
    /** Optional. Enables the enhanced coverage stream for top wallets. */
    heliusApiKey: process.env.HELIUS_API_KEY ?? "",

    port: num("PORT", 8790),

    gates: {
      whaleThresholdSol: num("WHALE_THRESHOLD_SOL", 10),
      whaleWindowMs: num("WHALE_WINDOW_MIN", 10) * 60_000,
      signalMinScore: num("SIGNAL_MIN_SCORE", 70),
      signalMinSettled: num("SIGNAL_MIN_SETTLED", 3),
      signalMinBuySol: num("SIGNAL_MIN_BUY_SOL", 1),
    },

    /** Wallets kept in memory and eligible for signals. LRU by last activity. */
    maxTracked: num("MAX_TRACKED_WALLETS", 200),
    /** Top-scored wallets the optional Helius stream follows off pump.fun. */
    heliusWalletSubs: num("HELIUS_WALLET_SUBS", 20),
    /** Helius getTransaction budget, requests per second (free tier is 10). */
    heliusRps: num("HELIUS_RPS", 6),

    pumpPortalUrl: process.env.PUMPPORTAL_URL ?? "wss://pumpportal.fun/api/data",
    rpcWsUrl: process.env.RPC_WS_URL ?? "wss://solana-rpc.publicnode.com",
  };
}

/** @typedef {ReturnType<typeof loadConfig>} Config */
