// Does the new list path actually deliver, against the live internet?
//
// The last time this app changed its list source, a single isolated latency
// measurement (320ms for one getToken) was generalised into a design, and under
// fan-out the real thing took 27 seconds and returned 2 of 12 rows. It was
// caught by a probe like this one and not by any test, because no test can tell
// you what a vendor does under concurrency.
//
// So this runs the REAL path — `trendingRows()`, the same function the scanner
// calls — and reports what a reader would actually see: how long, how many
// rows, how many are scored, and which fields are still declared unmeasured.

import { trendingRows } from "../src/lib/api/source";
import { getProviders, dataMode } from "../src/lib/providers/registry";
import { liveSignal } from "../src/lib/engine/live-features";

void (async () => {
  const mode = dataMode();
  console.log(`data mode: ${mode.overall}`);
  console.log(`  live      : ${mode.live.join(", ")}`);
  console.log(`  simulated : ${mode.simulated.join(", ")}\n`);

  const t0 = Date.now();
  const res = await trendingRows(12);
  const ms = Date.now() - t0;

  if (!res) {
    console.log("NO LIVE ROWS — the list fell back to the simulator.");
    return;
  }

  const rows = res.data;
  const scored = rows.filter((r) => r.scored);
  console.log(`${rows.length} rows in ${ms}ms from ${res.provenance.source} — ${scored.length} scored\n`);

  const has = (r: (typeof rows)[number], f: string) => !(r.unmeasured ?? []).includes(f as never);
  const col = (n: number | undefined, d = 1) => (n === undefined ? "  —  " : n.toFixed(d).padStart(7));

  console.log(
    "sym".padEnd(11) +
      "score".padStart(6) +
      "conf".padStart(6) +
      "risk".padStart(6) +
      "1h%".padStart(8) +
      "24h%".padStart(8) +
      "accel".padStart(7) +
      "top10%".padStart(8) +
      "holders".padStart(9) +
      "  origin",
  );
  for (const r of rows) {
    const origin = [r.launchpad ?? "", r.devMints !== undefined ? `${r.devMints} mints` : ""]
      .filter(Boolean)
      .join(" · ");
    console.log(
      r.symbol.slice(0, 10).padEnd(11) +
        String(r.scored ? r.signalScore.toFixed(0) : "—").padStart(6) +
        (r.scored ? r.confidence.toFixed(2) : "—").padStart(6) +
        String(r.riskScore ?? "—").padStart(6) +
        (has(r, "momentum") ? col(r.h1, 2) : "      —") +
        (has(r, "momentum") ? col(r.h24, 2) : "      —") +
        (has(r, "volumeAccel") ? col(r.volumeAccel, 2) : "      —") +
        (has(r, "top10Pct") ? col(r.top10Pct * 100, 1) : "      —") +
        String(has(r, "holders") ? r.holders.toLocaleString() : "—").padStart(9) +
        "  " +
        origin,
    );
  }

  // Which fields are STILL absent, and on how many rows. This is the number
  // that says whether the work actually moved anything.
  const tally = new Map<string, number>();
  for (const r of rows) for (const f of r.unmeasured ?? []) tally.set(f, (tally.get(f) ?? 0) + 1);
  console.log("\nstill unmeasured, by field (of " + rows.length + " rows):");
  for (const [f, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${f.padEnd(18)} ${n}`);
  }

  const conf = scored.map((r) => r.confidence);
  if (conf.length) {
    console.log(
      `\nconfidence: min ${Math.min(...conf).toFixed(2)} · mean ` +
        `${(conf.reduce((s, c) => s + c, 0) / conf.length).toFixed(2)} · max ${Math.max(...conf).toFixed(2)}`,
    );
  }

  // One token through the DETAILED path, which is what a token page does: full
  // risk report, candles, the lot.
  const p = getProviders();
  const target = rows[0];
  console.log(`\n--- detailed path for ${target.symbol} (${target.mint}) ---`);
  const d0 = Date.now();
  const sig = await liveSignal(
    target.mint,
    { token: p.token, market: p.market, security: p.security, flow: p.flow, risk: p.risk },
    "balanced",
    Date.now(),
    true,
  );
  console.log(`took ${Date.now() - d0}ms`);
  if (sig) {
    console.log(
      `score ${sig.signal.score.toFixed(0)} · confidence ${sig.signal.confidence.toFixed(2)} · ` +
        `LABEL "${sig.signal.label}"`,
    );
    const unassessable = sig.signal.factors.filter((x) => x.weight === 0).map((x) => x.key);
    console.log(`  factors that stood down: ${unassessable.join(", ") || "none"}`);
    for (const line of sig.result.provenance) console.log(`  ${line}`);
    const risk = sig.result.risk;
    if (risk?.topHolders) {
      console.log(
        `  top holders: ${risk.topHolders.length}, of which ${risk.labelledHolders} carry a label`,
      );
    }
  } else {
    console.log("no vector");
  }
})();
