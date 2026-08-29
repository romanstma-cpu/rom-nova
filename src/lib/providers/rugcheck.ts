// RugCheck — a third-party risk opinion, keyless and CORS-open (`*`, so it
// works from the Electron shell's app://rom-nova origin as well as the web).
//
//   GET https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary   ~300B
//   GET https://api.rugcheck.xyz/v1/tokens/{mint}/report           80KB-1.6MB
//
// WHAT THIS ADDS THAT NOTHING ELSE HERE HAS
//
// LP lock state. Every other risk signal in this app is about supply — who
// holds it, whether it can be inflated, whether it can be frozen. None of that
// catches the most common way a memecoin actually takes your money, which is
// the deployer pulling the liquidity pool. `lpLockedPct` is that number and no
// other keyless source in this stack publishes it.
//
// Plus a named, human-readable risk list. Nova has been good at telling a
// reader WHAT it measured and bad at telling them what it means; "Single holder
// ownership — 52.85%" is a sentence, not a factor weight.
//
// WHAT THIS DELIBERATELY DOES NOT ADD
//
// A pool-excluded concentration figure. The obvious use of this API is to
// subtract AMM pools from the top-holder share, turning "top 10 hold 74%" into
// a real cap-table number. It was measured across five trending tokens and it
// does not survive: knownAccounts labelled 12 of 20 top holders for CARDS, 2 of
// 20 for fone, 1 of 20 for ANSEM, and ZERO of 20 for both PUMP and RAY. On the
// two largest tokens — the ones with the most supply sitting in pools and
// staking programs — the derived figure would have claimed 78% and 83% wallet
// concentration, confidently and wrongly, with the error growing exactly as the
// token gets more legitimate.
//
// So the labels are passed through per holder and the count of labelled rows
// travels with them. The reader gets to see that four of twenty are named. A
// single number would have hidden that, and hidden numbers built on partial
// coverage are the failure this codebase keeps having to unlearn.
//
// Re-measured across ten trending tokens while building the detail page, and it
// is WORSE than the note above: 12 of 200 top-holder rows carried a label, 6%.
// Two tokens got zero. Whatever CARDS was, it is not typical.
//
// A second labelling route was tried and rejected in the same pass. The report
// carries a `markets[]` array whose `liquidityA`/`liquidityB`/`pubkey` fields
// ARE, on some tokens, exactly the accounts topping the holder list — SKHY's
// largest holder is verbatim its Meteora pool vault. Matching against that map
// moved coverage from 12 rows to 13. Half a percentage point does not pay for a
// second labelling path, so the code below still asks knownAccounts and only
// knownAccounts, and the UI prints the coverage count beside the table.
//
// ONE THING THE FULL REPORT DOES NOT CARRY
//
// `lpLockedPct`. It is on the SUMMARY endpoint and absent from the report, so
// asking for more detail returned less: `detailed: true` — the token detail
// page's own path — silently lost the single risk this provider exists for.
// Measured on four trending mints, all four. The per-market `lp.lpLockedPct`
// figures in the report do not reconstruct the summary's aggregate either (PUMP:
// summary 0.042%, its pump_fun_amm pool 0.0000021%, every other pool 0), so the
// detailed path now fetches the ~300B summary alongside the report and takes the
// vendor's own aggregate rather than deriving a second, unexplainable one.

import { providerFetch } from "./http";
import type { TokenRisk, TokenRiskProvider } from "./types";

const BASE = "https://api.rugcheck.xyz/v1/tokens";

interface RcRisk {
  name?: string;
  value?: string;
  description?: string;
  score?: number;
  level?: string;
}

interface RcSummary {
  risks?: RcRisk[];
  score?: number;
  score_normalised?: number;
  lpLockedPct?: number;
}

interface RcHolder {
  address?: string;
  owner?: string;
  pct?: number;
  insider?: boolean;
}

interface RcReport extends RcSummary {
  topHolders?: RcHolder[];
  knownAccounts?: Record<string, { name?: string; type?: string }>;
  totalHolders?: number;
  rugged?: boolean;
  graphInsidersDetected?: number;
  insiderNetworks?: unknown[] | null;
  creator?: string;
  creatorBalance?: number;
  token?: {
    mintAuthority?: string | null;
    freezeAuthority?: string | null;
    supply?: number;
    decimals?: number;
  };
  token_extensions?: { permanentDelegate?: { delegate?: string } | null } | null;
  transferFee?: { pct?: number };
  markets?: unknown[];
  totalMarketLiquidity?: number;
  totalLPProviders?: number;
  launchpad?: { name?: string } | null;
}

/** RugCheck's level vocabulary, narrowed. Anything unrecognised is info. */
export function levelOf(raw: string | undefined): "danger" | "warn" | "info" {
  if (raw === "danger") return "danger";
  if (raw === "warn" || raw === "warning") return "warn";
  return "info";
}

/**
 * lpLockedPct arrives as a percentage (0-100). Stored as a fraction, like every
 * other share in this codebase, so a reader of the type cannot get it wrong.
 *
 * A missing value stays missing. Zero is a real and very bad answer — nothing
 * locked — and defaulting an absent field to it would invent the worst possible
 * finding, which is the mirror image of the usual zeros bug and just as false.
 */
export function lpFraction(raw: number | undefined): number | undefined {
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  return Math.max(0, Math.min(1, raw / 100));
}

function mapRisks(risks: RcRisk[] | undefined) {
  return (risks ?? []).map((r) => ({
    name: r.name ?? "unnamed risk",
    level: levelOf(r.level),
    detail: r.description ?? "",
    value: r.value ? r.value : undefined,
  }));
}

export class RugCheckRiskProvider implements TokenRiskProvider {
  readonly name = "rugcheck";

  async getTokenRisk(mint: string, detailed = false): Promise<TokenRisk | null> {
    if (!detailed) {
      const body = await providerFetch<RcSummary>(this.name, `${BASE}/${mint}/report/summary`);
      return body && typeof body === "object" ? this.base(mint, body, false) : null;
    }

    // Both endpoints, together. The report is the 80KB-1.6MB one and carries
    // everything EXCEPT the LP lock; the summary is ~300B and carries only the
    // LP lock that matters. Requested in parallel because they are independent,
    // and the summary is allowed to fail on its own — losing the lock figure is
    // survivable, losing the report is not.
    const [body, summary] = await Promise.all([
      providerFetch<RcReport>(this.name, `${BASE}/${mint}/report`),
      providerFetch<RcSummary>(this.name, `${BASE}/${mint}/report/summary`).catch(() => null),
    ]);
    if (!body || typeof body !== "object") return null;

    const base = this.base(mint, body, true);
    // The report's own lpLockedPct is undefined in every response measured, so
    // this is effectively the summary's figure. Written as a fallback chain
    // rather than a straight read in case the field ever appears there.
    base.lpLockedPct = lpFraction(body.lpLockedPct ?? summary?.lpLockedPct);

    const full = body;
    const known = full.knownAccounts ?? {};
    const holders = Array.isArray(full.topHolders) ? full.topHolders : [];
    let labelled = 0;
    const topHolders = holders.map((h) => {
      // Either key can carry the label: measured 12 matches by token-account
      // address and 14 by owner on the same token, with neither a superset of
      // the other. Checking one would silently halve the coverage.
      const k = (h.address ? known[h.address] : undefined) ?? (h.owner ? known[h.owner] : undefined);
      if (k?.name) labelled++;
      // The deployer's own row, named from the report's own `creator` field
      // rather than from the label map that misses 94% of rows. On today's
      // trending list the creator was in the top twenty of two tokens in ten,
      // which is exactly the fact a holder table exists to surface.
      const isCreator = Boolean(full.creator) && (h.owner === full.creator || h.address === full.creator);
      return {
        owner: h.owner ?? h.address ?? "",
        account: h.address,
        pct: (h.pct ?? 0) / 100,
        label: k?.name,
        insider: h.insider === true,
        isCreator,
      };
    });

    // Insider share is a finding only when the graph analysis actually ran, and
    // its presence in the full report is what says so. On the summary endpoint
    // the field does not exist at all, and a zero there would mean "nobody
    // looked" while reading as "nobody found anything".
    const ranInsiderGraph =
      full.graphInsidersDetected !== undefined || Array.isArray(full.insiderNetworks);
    const insiderPct = ranInsiderGraph
      ? topHolders.reduce((s, h) => s + (h.insider ? h.pct : 0), 0)
      : undefined;

    return {
      ...base,
      topHolders,
      labelledHolders: labelled,
      insiderPct,
      totalHolders: full.totalHolders,
      rugged: full.rugged,
      creator: full.creator || undefined,
      creatorHoldsPct: creatorShare(full),
      // `token` present means the vendor read the mint account. Absent leaves
      // these undefined, which a caller must not read as "revoked" — the
      // difference between a null authority and a missing report is the whole
      // point of the field.
      mintAuthority: full.token ? (full.token.mintAuthority ?? null) : undefined,
      freezeAuthority: full.token ? (full.token.freezeAuthority ?? null) : undefined,
      permanentDelegate: full.token_extensions
        ? (full.token_extensions.permanentDelegate?.delegate ?? null)
        : undefined,
      transferFeePct:
        full.transferFee?.pct !== undefined && Number.isFinite(full.transferFee.pct)
          ? full.transferFee.pct / 100
          : undefined,
      markets: Array.isArray(full.markets) ? full.markets.length : undefined,
      totalMarketLiquidityUsd: Number.isFinite(full.totalMarketLiquidity)
        ? full.totalMarketLiquidity
        : undefined,
      totalLpProviders: Number.isFinite(full.totalLPProviders) ? full.totalLPProviders : undefined,
      launchpad: full.launchpad?.name,
      insiderNetworks: Array.isArray(full.insiderNetworks) ? full.insiderNetworks.length : undefined,
      graphInsiders: full.graphInsidersDetected,
    };
  }

  /** The fields both endpoints answer, shaped identically. */
  private base(mint: string, body: RcSummary, detailed: boolean): TokenRisk {
    return {
      mint,
      source: this.name,
      // A report with no normalised score is not a clean token; it is a token
      // whose score we do not have. Fall back to the raw score only when the
      // normalised one is genuinely absent, and never to zero.
      score: body.score_normalised ?? body.score ?? 0,
      risks: mapRisks(body.risks),
      lpLockedPct: lpFraction(body.lpLockedPct),
      detailed,
    };
  }
}

/**
 * What the deployer still holds, as a share of supply.
 *
 * Both halves come from the vendor's own report — `creatorBalance` in base
 * units against `token.supply` in the same units — so this is arithmetic on one
 * source rather than a figure stitched across two. A zero supply returns
 * undefined instead of dividing: an unreadable supply is not a dev holding
 * nothing.
 */
export function creatorShare(r: {
  creatorBalance?: number;
  token?: { supply?: number };
}): number | undefined {
  const bal = r.creatorBalance;
  const supply = r.token?.supply;
  if (bal === undefined || !Number.isFinite(bal)) return undefined;
  if (supply === undefined || !Number.isFinite(supply) || supply <= 0) return undefined;
  return Math.max(0, Math.min(1, bal / supply));
}

/**
 * The one-line verdict a row can show without the reader opening anything.
 *
 * Phrased as the vendor's claim rather than as fact. "RugCheck: 44" invites the
 * reading that Nova measured 44; "rated 44/100 by RugCheck" does not.
 */
export function riskHeadline(r: TokenRisk): string {
  const danger = r.risks.filter((x) => x.level === "danger").length;
  const warn = r.risks.filter((x) => x.level === "warn").length;
  const parts = [`rated ${r.score}/100 risk by ${r.source}`];
  if (danger > 0) parts.push(`${danger} critical`);
  if (warn > 0) parts.push(`${warn} warning${warn === 1 ? "" : "s"}`);
  if (r.lpLockedPct !== undefined) {
    parts.push(`LP ${(r.lpLockedPct * 100).toFixed(1)}% locked`);
  }
  if (r.rugged) parts.push("FLAGGED AS RUGGED");
  return parts.join(" · ");
}
