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
    const path = detailed ? `${BASE}/${mint}/report` : `${BASE}/${mint}/report/summary`;
    const body = await providerFetch<RcSummary | RcReport>(this.name, path);
    if (!body || typeof body !== "object") return null;

    const base: TokenRisk = {
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
    if (!detailed) return base;

    const full = body as RcReport;
    const known = full.knownAccounts ?? {};
    const holders = Array.isArray(full.topHolders) ? full.topHolders : [];
    let labelled = 0;
    const topHolders = holders.map((h) => {
      // Either key can carry the label: measured 12 matches by token-account
      // address and 14 by owner on the same token, with neither a superset of
      // the other. Checking one would silently halve the coverage.
      const k = (h.address ? known[h.address] : undefined) ?? (h.owner ? known[h.owner] : undefined);
      if (k?.name) labelled++;
      return {
        owner: h.owner ?? h.address ?? "",
        pct: (h.pct ?? 0) / 100,
        label: k?.name,
        insider: h.insider === true,
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
    };
  }
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
