// Is the signal LABEL carrying information, or is it a constant?
//
// `unmeasuredRisks >= 2` forces NO TRADE, and two of the three risk factors —
// insider share, and bundler/sniper share — have no source in this stack at any
// price. If that gate fires on every live token then the label is not an
// abstention, it is a fixed string, and the scanner's most prominent verdict
// column says the same thing about every row forever.

import { trendingRows } from "../src/lib/api/source";

void (async () => {
  const res = await trendingRows(12);
  if (!res) return console.log("no live rows");
  const tally = new Map<string, number>();
  for (const r of res.data) {
    tally.set(r.signalLabel, (tally.get(r.signalLabel) ?? 0) + 1);
    console.log(
      `${r.symbol.padEnd(12)} score ${String(r.signalScore.toFixed(0)).padStart(3)}  ` +
        `conf ${r.confidence.toFixed(2)}  risk ${String(r.riskScore ?? "—").padStart(3)}  ` +
        `${r.signalLabel}  [${r.signalKind}]`,
    );
  }
  console.log("\nlabel distribution:");
  for (const [k, v] of tally) console.log(`  ${k.padEnd(20)} ${v}`);
})();
