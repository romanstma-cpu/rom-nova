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

/**
 * Who may read the feed.
 *   open          anyone with the URL — the default, and what a self-hosted
 *                 worker for one person wants
 *   account       anyone signed in through Supabase Auth (email code)
 *   subscription  signed in AND holding an active Stripe subscription
 */
export const ACCESS_MODES = ["open", "account", "subscription"];

export function loadConfig() {
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  const supabaseUrl = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY ?? "";
  if (!dryRun && (!supabaseUrl || !supabaseServiceKey)) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_KEY are required (or set DRY_RUN=1 to run with an in-memory store).",
    );
  }

  const access = (process.env.RADAR_ACCESS ?? "open").trim().toLowerCase() || "open";
  if (!ACCESS_MODES.includes(access)) {
    throw new Error(`RADAR_ACCESS must be one of ${ACCESS_MODES.join(", ")} — got "${access}"`);
  }
  // The anon (publishable) key is public by design: the app fetches it from
  // /config to sign people in. It is the SERVICE key that must never leave
  // this process.
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";
  if (access !== "open" && (!supabaseUrl || !supabaseAnonKey)) {
    throw new Error(`RADAR_ACCESS=${access} needs SUPABASE_URL and SUPABASE_ANON_KEY — the app signs in through them.`);
  }
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY ?? "";
  const stripePriceId = process.env.STRIPE_PRICE_ID ?? "";
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  if (access === "subscription" && (!stripeSecretKey || !stripePriceId || !stripeWebhookSecret)) {
    throw new Error("RADAR_ACCESS=subscription needs STRIPE_SECRET_KEY, STRIPE_PRICE_ID and STRIPE_WEBHOOK_SECRET.");
  }

  return {
    dryRun,
    supabaseUrl,
    supabaseServiceKey,
    supabaseAnonKey,
    /** Optional. Enables the enhanced coverage stream for top wallets. */
    heliusApiKey: process.env.HELIUS_API_KEY ?? "",

    port: num("PORT", 8790),

    access,
    stripeSecretKey,
    stripePriceId,
    stripeWebhookSecret,
    /** Where Stripe sends people back to: the app's origin plus its base path, no trailing slash. */
    appUrl: (process.env.APP_URL ?? "https://romapps.xyz/nova").replace(/\/+$/, ""),
    /**
     * A subscription whose period ended this long ago still counts. Renewal
     * webhooks land minutes after the period rolls, and a paying reader must
     * not lose the feed for the time Stripe's retries take.
     */
    entitlementGraceMs: num("ENTITLEMENT_GRACE_HOURS", 24) * 3_600_000,

    /** The HTTP API: requests a key (or a session) may make per minute, and keys a reader may hold. */
    apiRatePerMinute: num("API_RATE_PER_MIN", 60),
    apiKeysPerUser: num("API_KEYS_PER_USER", 10),

    /**
     * Referral codes the app puts on its handoff links, by venue. Public by
     * design (they are in every link), set here so the app ships none and a
     * self-hosted worker carries its own operator's. Empty means plain links.
     */
    referrals: {
      gmgn: (process.env.REFERRAL_GMGN ?? "").trim(),
    },

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
