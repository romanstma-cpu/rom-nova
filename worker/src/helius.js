// Optional Helius coverage: tracked wallets BEYOND the pump.fun curve.
//
// The keyless program stream sees every bonding-curve trade, but a proven
// wallet keeps trading after tokens migrate to AMMs — and those fills are
// invisible to it. With HELIUS_API_KEY set, this module logsSubscribes to
// the top-scored wallets (standard WebSocket method, available on the free
// tier), fetches each mentioned transaction over HTTPS inside a hard
// request budget, and reads the wallet's own token/SOL balance deltas into
// the same fill shape the program stream produces.
//
// Without the key the module is inert and /health says so — coverage is
// then "pump.fun bonding curve only", printed, not implied otherwise.
// UNMEASURED until run with a real key: this path ships structurally tested
// (fixture transactions through parseHeliusTx) but has never spoken to
// Helius from this codebase; its first live run belongs to the operator.

import { PUMP_PROGRAM } from "./decode.js";
import { ReconnectingWs } from "./sockets.js";
import { LruSet, log } from "./util.js";

const RESUB_MS = 5 * 60_000;

/**
 * Read one wallet's fills out of a jsonParsed getTransaction body.
 * Exported pure for the tests.
 *
 * A "fill" here is: the wallet's balance of some SPL token moved, and its
 * SOL moved the other way. One transaction can carry several (a routed swap
 * touching two tokens produces a sell-leg and a buy-leg).
 *
 * @param {any} tx getTransaction result (jsonParsed)
 * @param {string} wallet
 * @returns {{ mint: string, isBuy: boolean, sol: number, tokens: number, priceSol: number, chainTs: number }[]}
 */
export function parseHeliusTx(tx, wallet) {
  const meta = tx?.meta;
  const msg = tx?.transaction?.message;
  if (!meta || meta.err !== null || !msg) return [];

  // Skip transactions the program stream already covers.
  const keys = (msg.accountKeys ?? []).map((k) => (typeof k === "string" ? k : k?.pubkey));
  if (keys.includes(PUMP_PROGRAM)) return [];

  const walletIx = keys.indexOf(wallet);
  if (walletIx < 0) return [];
  const solDelta = ((meta.postBalances?.[walletIx] ?? 0) - (meta.preBalances?.[walletIx] ?? 0)) / 1e9;

  /** @type {Map<string, number>} mint → token delta (ui units) */
  const deltas = new Map();
  for (const b of meta.preTokenBalances ?? []) {
    if (b?.owner !== wallet || !b.mint) continue;
    deltas.set(b.mint, (deltas.get(b.mint) ?? 0) - (b.uiTokenAmount?.uiAmount ?? 0));
  }
  for (const b of meta.postTokenBalances ?? []) {
    if (b?.owner !== wallet || !b.mint) continue;
    deltas.set(b.mint, (deltas.get(b.mint) ?? 0) + (b.uiTokenAmount?.uiAmount ?? 0));
  }

  const chainTs = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
  const out = [];
  for (const [mint, tokDelta] of deltas) {
    if (Math.abs(tokDelta) < 1e-9) continue;
    const isBuy = tokDelta > 0;
    // The SOL leg: what the wallet's lamports did, net of fees. A buy costs
    // SOL (delta negative), a sell earns it. When SOL moved the same way as
    // the token (an airdrop, a transfer-in), there is no trade to record.
    const sol = isBuy ? -solDelta : solDelta;
    if (sol <= 0) continue;
    const tokens = Math.abs(tokDelta);
    out.push({ mint, isBuy, sol, tokens, priceSol: tokens > 0 ? sol / tokens : 0, chainTs });
  }
  return out;
}

export class HeliusStream {
  /**
   * @param {import("./config.js").Config} cfg
   * @param {() => string[]} topWallets addresses to follow, freshest score first
   * @param {(trade: any) => void} onTrade
   */
  constructor(cfg, topWallets, onTrade) {
    this.cfg = cfg;
    this.topWallets = topWallets;
    this.onTrade = onTrade;
    this.enabled = Boolean(cfg.heliusApiKey);
    /** @type {ReconnectingWs | null} */
    this.ws = null;
    /** @type {string[]} */
    this.subscribed = [];
    this.seenSigs = new LruSet(4_000);
    this.txFetches = 0;
    this.txErrors = 0;
    this.fills = 0;
    /** naive token bucket for the HTTPS budget */
    this.budget = cfg.heliusRps;
    /** @type {ReturnType<typeof setInterval> | null} */ this.refill = null;
    /** @type {ReturnType<typeof setInterval> | null} */ this.resub = null;
  }

  start() {
    if (!this.enabled) return;
    const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${this.cfg.heliusApiKey}`;
    this.ws = new ReconnectingWs({
      name: "helius",
      url: wsUrl,
      onOpenSend: () => {
        this.subscribed = this.topWallets().slice(0, this.cfg.heliusWalletSubs);
        return this.subscribed.map((w, i) => ({
          jsonrpc: "2.0",
          id: 100 + i,
          method: "logsSubscribe",
          params: [{ mentions: [w] }, { commitment: "confirmed" }],
        }));
      },
      // Followed wallets can genuinely sleep; keep the socket honest with a
      // cheap request instead of declaring silence fatal.
      silenceMs: 120_000,
      ping: () => ({ jsonrpc: "2.0", id: 1, method: "getVersion" }),
      onMessage: (msg) => {
        if (msg?.method !== "logsNotification") return;
        const sig = msg.params?.result?.value?.signature;
        if (typeof sig !== "string" || msg.params?.result?.value?.err !== null) return;
        if (!this.seenSigs.add(sig)) return;
        this.fetchTx(sig).catch(() => {});
      },
    });
    this.ws.start();
    this.refill = setInterval(() => {
      this.budget = this.cfg.heliusRps;
    }, 1_000);
    this.resub = setInterval(() => this.refreshSubs(), RESUB_MS);
    log(`[helius] enabled — following up to ${this.cfg.heliusWalletSubs} top wallets off-curve`);
  }

  /** Follow the current top set: reconnecting is the simplest resubscribe. */
  refreshSubs() {
    const want = this.topWallets().slice(0, this.cfg.heliusWalletSubs);
    if (want.join() === this.subscribed.join()) return;
    log("[helius] top set changed — resubscribing");
    try {
      this.ws?.ws?.close();
    } catch {
      /* reconnect path handles it */
    }
  }

  /** @param {string} sig */
  async fetchTx(sig) {
    if (this.budget <= 0) return; // over budget — skip, do not queue into a spiral
    this.budget--;
    this.txFetches++;
    try {
      const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${this.cfg.heliusApiKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
        }),
        signal: AbortSignal.timeout(6_000),
      });
      const body = await res.json();
      const tx = body?.result;
      if (!tx) return;
      for (const wallet of this.subscribed) {
        for (const fill of parseHeliusTx(tx, wallet)) {
          this.fills++;
          this.onTrade({ ...fill, user: wallet, signature: sig, venue: "helius" });
        }
      }
    } catch {
      this.txErrors++;
    }
  }

  status() {
    if (!this.enabled) return { enabled: false, note: "HELIUS_API_KEY not set — coverage is pump.fun bonding curve only" };
    return {
      enabled: true,
      socket: this.ws?.status() ?? null,
      following: this.subscribed.length,
      txFetches: this.txFetches,
      txErrors: this.txErrors,
      offCurveFills: this.fills,
    };
  }

  stop() {
    if (this.refill) clearInterval(this.refill);
    if (this.resub) clearInterval(this.resub);
    this.ws?.stop();
  }
}
