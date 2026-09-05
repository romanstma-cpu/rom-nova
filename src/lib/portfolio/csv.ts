// The FIFO rows as a CSV a spreadsheet or an accountant can open.
//
// One row per fill, a note column that says exactly why a figure is blank,
// and no totals row — a total would be summed by whoever opens it and
// mistaken for a claim. The file name carries "fifo-estimate" for the
// same reason the page does.

import type { FifoRow } from "./fifo";

export const FIFO_CSV_COLUMNS = [
  "date_utc",
  "side",
  "mint",
  "symbol",
  "tokens",
  "price_usd",
  "value_usd",
  "matched_tokens",
  "unmatched_tokens",
  "cost_basis_usd",
  "proceeds_usd",
  "realized_pnl_usd",
  "hold_days",
  "term",
  "signature",
  "note",
] as const;

/** RFC 4180: quote when the value carries a comma, a quote or a newline; double the quotes. */
export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const money = (v: number | null): string => (v === null ? "" : v.toFixed(2));
const qty = (v: number | null): string => (v === null ? "" : String(v));

export function fifoCsv(rows: readonly FifoRow[]): string {
  const lines = [FIFO_CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        new Date(r.ts).toISOString(),
        r.side,
        r.mint,
        r.symbol,
        qty(r.tokens),
        r.priceUsd === null ? "" : String(r.priceUsd),
        money(r.valueUsd),
        r.side === "sell" ? qty(r.matchedTokens) : "",
        r.side === "sell" ? qty(r.unmatchedTokens) : "",
        money(r.costBasisUsd),
        money(r.proceedsUsd),
        money(r.realizedPnlUsd),
        r.holdDays === null ? "" : r.holdDays.toFixed(2),
        r.longTerm === null ? "" : r.longTerm ? "long" : "short",
        r.signature,
        r.note,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** The file name: the wallet, the day, and the word estimate. */
export function fifoCsvName(address: string, now = Date.now()): string {
  const short = address.length > 12 ? `${address.slice(0, 6)}-${address.slice(-4)}` : address;
  return `rom-nova-fifo-estimate-${short}-${new Date(now).toISOString().slice(0, 10)}.csv`;
}
