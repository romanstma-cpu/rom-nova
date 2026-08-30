// Does the verdict DISCRIMINATE on live data?
//
// The abstention gate has now failed in both directions. It began as a raw
// count that abstained on almost everything (five of six mints, a verdict
// carrying no information). It was replaced by a share of all risk factors,
// which broke the other way the moment the risk list grew — a token with its
// cap table, insiders, bundlers and dev holdings ALL unknown scored EXTREME
// POSITIVE on the strength of its authorities.
//
// It is now a named family gate. This sweep is the check that the third version
// is neither of the first two: real trending mints should produce a SPREAD of
// verdicts, and the dangerous ones should sit at the bottom.

import { trendingRows } from "../src/lib/api/source";

void (async () => {
  const res = await trendingRows(12);
  if (!res) return console.log("no live rows — cannot judge");

  const tally = new Map<string, number>();
  const scores: number[] = [];

  console.log("sym          score  conf  risk  verdict           why not tradeable");
  for (const r of res.data) {
    tally.set(r.signalLabel, (tally.get(r.signalLabel) ?? 0) + 1);
    if (r.scored) scores.push(r.signalScore);
    console.log(
      r.symbol.slice(0, 12).padEnd(13) +
        String(r.scored ? r.signalScore.toFixed(0) : "—").padStart(5) +
        (r.scored ? r.confidence.toFixed(2) : "—").padStart(6) +
        String(r.riskScore ?? "—").padStart(6) +
        "  " +
        r.signalLabel.padEnd(17) +
        (r.unscoredReason ?? "").slice(0, 70),
    );
  }

  console.log("\nlabel distribution:");
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(18)} ${v}`);
  }
  if (scores.length) {
    console.log(
      `\nscore spread: ${Math.min(...scores).toFixed(0)} … ${Math.max(...scores).toFixed(0)} ` +
        `(range ${(Math.max(...scores) - Math.min(...scores)).toFixed(0)})`,
    );
  }
  // The two failure modes, named so the output judges itself.
  if (tally.size === 1) {
    console.log("\nFAIL: one label across every row — the verdict carries no information.");
  } else {
    console.log(`\nOK: ${tally.size} distinct verdicts across ${res.data.length} rows.`);
  }
})();
