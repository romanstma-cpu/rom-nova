// Where a reader trades a token, in their own wallet. Nova opens a tab and
// steps back; it never holds a key and never routes an order.
//
// Some venues pay the operator a share of the fee for readers they sent.
// Those codes are not in this file: the hosted radar publishes them over
// /config, a self-hosted worker publishes its own operator's, and an app
// that reached no radar builds plain links. A link that carries a code is
// labelled so on the page — it costs the reader nothing, and the reader
// should know.
//
// Formats are the venue's own documented ones (GMGN: docs.gmgn.ai →
// Referral Link), not guesses; a venue whose token deep link with a code
// is undocumented is not here.

export interface Referrals {
  gmgn?: string;
}

const CODE_RE = /^[A-Za-z0-9_-]{2,32}$/;

/** Only venues this file knows, only codes shaped like codes. */
export function cleanReferrals(raw: unknown): Referrals {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Referrals = {};
  if (typeof o.gmgn === "string" && CODE_RE.test(o.gmgn)) out.gmgn = o.gmgn;
  return out;
}

export interface TradeLink {
  label: string;
  href: string;
  /** carries the operator's referral code */
  referral: boolean;
  kind: "web" | "telegram";
}

interface Venue {
  label: string;
  kind: "web" | "telegram";
  /** null: this venue has no link without a code */
  href: (mint: string, refs: Referrals) => { href: string; referral: boolean } | null;
}

const VENUES: Venue[] = [
  { label: "pump.fun", kind: "web", href: (m) => ({ href: `https://pump.fun/coin/${m}`, referral: false }) },
  { label: "Jupiter", kind: "web", href: (m) => ({ href: `https://jup.ag/swap/SOL-${m}`, referral: false }) },
  {
    label: "GMGN",
    kind: "web",
    href: (m, r) => (r.gmgn ? { href: `https://gmgn.ai/sol/token/${r.gmgn}_${m}`, referral: true } : { href: `https://gmgn.ai/sol/token/${m}`, referral: false }),
  },
  {
    label: "GMGN bot",
    kind: "telegram",
    href: (m, r) => (r.gmgn ? { href: `https://t.me/GMGN_sol_bot?start=i_${r.gmgn}_c_${m}`, referral: true } : null),
  },
  { label: "DexScreener", kind: "web", href: (m) => ({ href: `https://dexscreener.com/solana/${m}`, referral: false }) },
];

/** The links for one mint, in the order the page shows them. */
export function tradeLinks(mint: string, refs: Referrals = {}): TradeLink[] {
  const out: TradeLink[] = [];
  for (const v of VENUES) {
    const built = v.href(mint, refs);
    if (built) out.push({ label: v.label, kind: v.kind, ...built });
  }
  return out;
}

/** The same table as rows the radar page maps per signal: a label and a builder. */
export function venueRows(refs: Referrals = {}): { label: string; href: (mint: string) => string }[] {
  const rows: { label: string; href: (mint: string) => string }[] = [];
  for (const v of VENUES) {
    const probe = v.href("probe", refs);
    if (!probe) continue;
    rows.push({ label: probe.referral ? `${v.label} · ref` : v.label, href: (mint) => v.href(mint, refs)!.href });
  }
  return rows;
}
