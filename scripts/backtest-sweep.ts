// Scores the backtester across independent simulated worlds.
//
// The trader's recorded Kalshi data can only ever be cut into folds of one
// history, so a good fold is always partly luck about that week. Nova's market
// is seeded, which means a different seed is a genuinely different world drawn
// from the same generator — the out-of-sample test that recorded data cannot
// offer. A configuration that only makes money in some worlds is a
// configuration that makes money by accident.
//
//   npx esbuild scripts/backtest-sweep.ts --bundle --platform=node \
//     --outfile=node_modules/.cache/sweep.cjs --log-level=error
//   node node_modules/.cache/sweep.cjs

import { DemoStore } from "../src/lib/demo/store";
import { runBacktest, DEFAULT_BACKTEST } from "../src/lib/engine/backtest";
import type { BacktestConfig } from "../src/lib/types";

const SEEDS = [77, 1234, 2026, 31337, 8675309, 424242, 90210, 5150];

const stores = SEEDS.map((s) => new DemoStore(s));

interface Row {
  label: string;
  cfg: Partial<BacktestConfig>;
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function score(rows: Row[], title: string): void {
  console.log(`\n${title}`);
  console.log(
    `  ${"config".padEnd(28)} ${"trades".padStart(7)} ${"win".padStart(5)} ${"PF".padStart(6)} ` +
      `${"mean".padStart(8)} ${"median".padStart(8)} ${"worlds+".padStart(8)} ${"worst".padStart(8)} ${"maxDD".padStart(7)}`,
  );
  console.log(
    `  ${"-".repeat(28)} ${"-".repeat(7)} ${"-".repeat(5)} ${"-".repeat(6)} ${"-".repeat(8)} ${"-".repeat(8)} ${"-".repeat(8)} ${"-".repeat(8)} ${"-".repeat(7)}`,
  );
  for (const row of rows) {
    const results = stores.map((st) => runBacktest(st, { ...DEFAULT_BACKTEST, ...row.cfg }));
    const rets = results.map((r) => r.totalReturnPct).sort((a, b) => a - b);
    const trades = results.reduce((a, r) => a + r.trades.length, 0);
    const wins = results.reduce((a, r) => a + r.trades.filter((t) => t.pnlUsd > 0).length, 0);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const median = rets[Math.floor(rets.length / 2)];
    const positive = rets.filter((r) => r > 0).length;
    const dd = Math.max(...results.map((r) => r.maxDrawdownPct));
    const pfs = results.map((r) => r.profitFactor).filter((p) => p < 99);
    const pf = pfs.length ? pfs.reduce((a, b) => a + b, 0) / pfs.length : 0;
    const badIntegrity = results.filter((r) => !r.integrity.lookaheadChecksPassed).length;
    console.log(
      `  ${row.label.padEnd(28)} ${String(trades).padStart(7)} ` +
        `${(trades ? `${Math.round((wins / trades) * 100)}%` : "—").padStart(5)} ` +
        `${pf.toFixed(2).padStart(6)} ${pct(mean).padStart(8)} ${pct(median).padStart(8)} ` +
        `${`${positive}/${rets.length}`.padStart(8)} ${pct(rets[0]).padStart(8)} ${`${dd.toFixed(0)}%`.padStart(7)}` +
        (badIntegrity ? `  LOOKAHEAD FAILED in ${badIntegrity}` : ""),
    );
  }
}

console.log(`=== Nova backtest across ${SEEDS.length} independent worlds ===`);
console.log(`  seeds: ${SEEDS.join(", ")}`);
console.log(`  each run: ${DEFAULT_BACKTEST.days} days, $10,000 start, $${DEFAULT_BACKTEST.positionUsd}/position`);

score([{ label: "shipped defaults", cfg: {} }], "Baseline");

score(
  [
    { label: "minScore 60", cfg: { minScore: 60 } },
    { label: "minScore 70 (default)", cfg: {} },
    { label: "minScore 78", cfg: { minScore: 78 } },
    { label: "minScore 85", cfg: { minScore: 85 } },
  ],
  "How selective to be about the score",
);

score(
  [
    { label: "hold 6h", cfg: { holdHours: 6 } },
    { label: "hold 12h", cfg: { holdHours: 12 } },
    { label: "hold 24h (default)", cfg: {} },
    { label: "hold 48h", cfg: { holdHours: 48 } },
    { label: "hold 96h", cfg: { holdHours: 96 } },
  ],
  "How long to hold",
);

score(
  [
    { label: "sl10 tp20", cfg: { stopLossPct: 10, takeProfitPct: 20 } },
    { label: "sl20 tp40 (default)", cfg: {} },
    { label: "sl30 tp60", cfg: { stopLossPct: 30, takeProfitPct: 60 } },
    { label: "sl20 tp80", cfg: { takeProfitPct: 80 } },
    { label: "sl40 tp40", cfg: { stopLossPct: 40 } },
  ],
  "Where to put the barriers",
);

score(
  [
    { label: "conservative", cfg: { profile: "conservative" } },
    { label: "balanced (default)", cfg: {} },
    { label: "aggressive", cfg: { profile: "aggressive" } },
  ],
  "Signal profile",
);

score(
  [
    { label: "conf 0.30", cfg: { minConfidence: 0.3 } },
    { label: "conf 0.45 (default)", cfg: {} },
    { label: "conf 0.60", cfg: { minConfidence: 0.6 } },
    { label: "conf 0.75", cfg: { minConfidence: 0.75 } },
  ],
  "How much confidence to demand",
);

console.log(
  "\n  'worlds+' is the count of seeds where the run ended above its starting balance.\n" +
    "  A configuration that is positive on average but loses in half its worlds has\n" +
    "  a distribution, not an edge.\n",
);
