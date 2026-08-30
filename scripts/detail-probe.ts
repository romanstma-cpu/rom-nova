/**
 * Assemble the token detail page's payload for a REAL mint and print it.
 *
 * The detail page was simulator-only until now — every link out of the live
 * scanner carried a real Solana mint into a handler that reads the synthetic
 * store, and landed on "Token not found". This is the probe that proves the
 * live path returns something, and more importantly that it returns the RIGHT
 * absences: a holder table with its label coverage, factors that stood down
 * with their weights, and any question two sources answer differently.
 *
 *   npm run probe:detail -- <mint|symbol> [profile]
 *
 * With no argument it takes whatever is trending right now, which is the case
 * that matters: a fixed mint stops being representative within a day.
 */
import { liveTokenDetail } from "../src/lib/api/detail";
import { JupiterTokenProvider } from "../src/lib/providers/jupiter";
import type { StrategyProfileId } from "../src/lib/types";

const bar = (n: number, width = 18) => {
  const filled = Math.round(Math.max(0, Math.min(1, n)) * width);
  return "█".repeat(filled) + "·".repeat(width - filled);
};
const usd = (x: number) =>
  `${x < 0 ? "-" : ""}$${Math.abs(x) >= 1e6 ? (Math.abs(x) / 1e6).toFixed(2) + "M" : Math.abs(x) >= 1e3 ? (Math.abs(x) / 1e3).toFixed(1) + "K" : Math.abs(x).toFixed(0)}`;
const short = (a: string) => (a.length <= 12 ? a : `${a.slice(0, 5)}…${a.slice(-4)}`);

async function main(): Promise<void> {
  const profile = (process.argv[3] ?? "balanced") as StrategyProfileId;
  let mint = process.argv[2];
  if (!mint) {
    const trending = await new JupiterTokenProvider().getTrendingDetailed(1);
    mint = trending[0]?.mint ?? "";
    console.log(`no mint given — taking the top trending one: ${trending[0]?.symbol} ${mint}`);
  }

  const started = Date.now();
  const d = await liveTokenDetail(mint, profile);
  const ms = Date.now() - started;
  if (!d) {
    console.log(`\n  no live detail for ${mint} — the page falls back to the simulator.\n`);
    return;
  }

  console.log(`\n=== ${d.info.symbol} · ${d.info.name} · assembled in ${ms}ms ===`);
  console.log(`  price ${usd(d.snapshot.priceUsd)}  mcap ${usd(d.snapshot.marketCapUsd)}  liq ${usd(d.snapshot.liquidityUsd)}`);
  console.log(`  ${d.signal.label}  score ${d.signal.score}/100  confidence ${(d.signal.confidence * 100).toFixed(0)}%`);
  if (d.signal.noTradeReason) console.log(`  NO TRADE: ${d.signal.noTradeReason}`);
  console.log(`  model coverage ${(d.audit.coverage * 100).toFixed(0)}%  weight unused ${d.audit.missingWeight.toFixed(1)}  risk factors unassessed ${d.audit.unmeasuredRisks}`);

  console.log(`\n  SCORE, EVERY FACTOR`);
  for (const r of d.audit.rows) {
    if (!r.measured) {
      console.log(`    ${r.name.padEnd(26)} STOOD DOWN (weight ${r.intendedWeight})  ${r.explanation}`);
      continue;
    }
    console.log(
      `    ${r.name.padEnd(26)} ${bar(r.normalized)} w${String(r.intendedWeight).padStart(5)}  ${r.contribution >= 0 ? "+" : ""}${r.contribution.toFixed(1)}`,
    );
    console.log(`      ${r.explanation}`);
  }

  console.log(`\n  HOLDERS — ${d.holders.rows.length} published by ${d.holders.source ?? "nobody"}, ${d.holders.labelled} labelled`);
  console.log(`    they sum to ${(d.holders.listedPct * 100).toFixed(1)}% of supply; vendor total holders ${d.holders.totalHolders?.toLocaleString() ?? "—"}`);
  for (const h of d.holders.rows.slice(0, 8)) {
    console.log(
      `    ${String(h.rank).padStart(2)}. ${short(h.owner).padEnd(13)} ${(h.pct * 100).toFixed(2).padStart(6)}%  ${h.label ?? "(unlabelled)"}${h.insider ? "  INSIDER" : ""}${h.isCreator ? "  CREATOR" : ""}`,
    );
  }

  const c = d.creator;
  console.log(`\n  CREATOR`);
  console.log(`    address ${c.address ?? "—"}${c.vendorAddress && c.vendorAddress !== c.address ? `  (vendor says ${c.vendorAddress})` : ""}`);
  console.log(`    mints ${c.mints ?? "—"}  migrations ${c.migrations ?? "—"}  launchpad ${c.launchpad ?? "—"}`);
  // Reads `holdsShown`, exactly as the page does. Printing `holdsPct` and
  // `vendorHoldsPct` as two independent lines is what produced "still holds
  // UNMEASURED (vendor 0.000%)" — the probe reproducing the page's own
  // contradiction, one line apart, on PUMP, SKHY, TRX and CATE.
  console.log(
    `    still holds ${
      c.holdsShown ? `${(c.holdsShown.pct * 100).toFixed(3)}% (per ${c.holdsShown.source})` : "UNMEASURED — nobody published it"
    }${
      c.vendorHoldsPct !== undefined && c.holdsShown && c.holdsShown.source !== d.risk?.source
        ? `  (${d.risk?.source} independently says ${(c.vendorHoldsPct * 100).toFixed(3)}%)`
        : ""
    }`,
  );
  const s = d.supply;
  console.log(
    `    supply ${s.supply !== undefined ? s.supply.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}` +
      `  fdv ${s.fdvUsd !== undefined ? usd(s.fdvUsd) : "—"}` +
      `  liq/mcap ${s.liqToMcap !== undefined ? `${(s.liqToMcap * 100).toFixed(2)}%` : "—"}`,
  );

  console.log(`\n  SECURITY`);
  console.log(`    authorities ${d.authorityChecked ? `read by ${d.authoritySource}` : "UNVERIFIED — nobody read the mint account"}`);
  console.log(`    mint ${d.info.mintAuthorityRevoked ? "revoked" : "LIVE"}  freeze ${d.info.freezeAuthorityRevoked ? "revoked" : "LIVE"}`);
  if (d.risk) {
    console.log(`    ${d.risk.source} grades ${d.risk.score}/100 risk · LP ${d.risk.lpLockedPct !== undefined ? `${(d.risk.lpLockedPct * 100).toFixed(2)}% locked` : "lock NOT REPORTED"}`);
    console.log(`    pools ${d.risk.markets ?? "—"}  LP providers ${d.risk.totalLpProviders ?? "—"}  insider networks ${d.risk.insiderNetworks ?? "—"} (${d.risk.graphInsiders ?? "—"} wallets)`);
    console.log(`    permanent delegate ${d.risk.permanentDelegate === undefined ? "not reported" : (d.risk.permanentDelegate ?? "none")}`);
    for (const r of d.risk.risks) console.log(`    [${r.level}] ${r.name}${r.value ? ` — ${r.value}` : ""}`);
  }

  if (d.flow) {
    console.log(`\n  FLOW — ${d.flow.source}, ${d.flow.minutesCovered.toFixed(1)} of ${d.flow.minutesRequested} min${d.flow.complete ? "" : " (BUDGET CUT)"}, ${d.flow.megabytesRead.toFixed(1)}MB`);
    console.log(`    ${d.flow.movements} balance changes across ${d.flow.wallets} wallets · ${d.flow.buyers} buyers / ${d.flow.sellers} sellers · ${d.flow.touchedNotMoved} rows touched but unchanged`);
    for (const m of d.flow.movers.slice(0, 6)) {
      console.log(`    ${short(m.owner).padEnd(13)} ${m.usd >= 0 ? "+" : ""}${usd(m.usd).padStart(9)}`);
    }
  } else {
    console.log(`\n  FLOW — no provider answered; whale flow unmeasured`);
  }

  console.log(`\n  DISAGREEMENTS (${d.disagreements.length})`);
  for (const x of d.disagreements) {
    console.log(`    ${x.question}?`);
    for (const c2 of x.claims) console.log(`      ${c2.source}: ${c2.value}`);
    console.log(`      ${x.note}`);
  }

  console.log(`\n  PROVENANCE`);
  for (const p of d.provenance) console.log(`    · ${p}`);
  console.log("");
}

void main();
