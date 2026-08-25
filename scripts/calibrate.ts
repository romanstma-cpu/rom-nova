// Calibration probe: prints score distribution and wallet-cohort separation
// so engine tuning is done on evidence, not feel. Run: node scripts/calibrate.ts

import { DemoStore } from "../src/lib/demo/store";
import { signalsAt } from "../src/lib/engine/signals";

const store = new DemoStore(77);
const genesis = store.universe.genesis;
const DAY = 86_400_000;

console.log("=== wallet cohorts (avg smart-money total) ===");
const byLabel = new Map<string, number[]>();
for (const w of store.walletList()) {
  const key = w.labels[0];
  const arr = byLabel.get(key) ?? [];
  arr.push(w.smartMoney.total);
  byLabel.set(key, arr);
}
for (const [label, xs] of byLabel) {
  const ws = store.walletList().filter((w) => w.labels[0] === label);
  const perf = ws.map((w) => store.perfs.get(w.address)!);
  const pnl = perf.reduce((s, p) => s + p.realizedPnlUsd + p.unrealizedPnlUsd, 0);
  const av = (f: (w: (typeof ws)[0]) => number) => (ws.reduce((s, w) => s + f(w), 0) / ws.length).toFixed(0);
  const avp = (f: (p: (typeof perf)[0]) => number) => (perf.reduce((s, p) => s + f(p), 0) / perf.length).toFixed(2);
  console.log(
    `${label.padEnd(14)} n=${xs.length} score=${av((w) => w.smartMoney.total)} perf=${av((w) => w.smartMoney.performance)} tim=${av((w) => w.smartMoney.timing)} con=${av((w) => w.smartMoney.consistency)} rm=${av((w) => w.smartMoney.riskManagement)} div=${av((w) => w.smartMoney.diversification)} dc=${av((w) => w.smartMoney.dataConfidence)} | rt=${avp((p) => p.trades)} wr=${avp((p) => p.winRate)} pf=${avp((p) => Math.min(p.profitFactor, 10))} pnl=$${Math.round(pnl / 1000)}K`,
  );
}

console.log("\n=== signal score distribution across 6 daily buckets ===");
const buckets = [0, 1, 2, 3, 4, 5];
const hist = new Array(10).fill(0);
let noTrade = 0;
let total = 0;
let over64 = 0;
let over76 = 0;
for (const d of buckets) {
  for (const s of signalsAt(store, genesis - d * DAY, "balanced")) {
    total++;
    if (s.label === "NO TRADE") noTrade++;
    hist[Math.min(9, Math.floor(s.score / 10))]++;
    if (s.score >= 64) over64++;
    if (s.score >= 76) over76++;
  }
}
hist.forEach((n, i) => console.log(`${i * 10}-${i * 10 + 9}: ${"#".repeat(Math.round((n / total) * 120))} ${n}`));
console.log(`total=${total} noTrade=${noTrade} ≥64: ${over64} ≥76: ${over76}`);
