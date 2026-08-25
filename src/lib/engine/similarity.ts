// Historical similarity. Given a token's current setup, find moments in
// OTHER tokens' histories that looked alike, and report the outcome
// distribution — never "this will do X", always "similar setups did X".

import type { DemoStore } from "../demo/store";
import { DAY } from "../demo/universe";
import { extractFeatures } from "./features";
import type { FeatureVector } from "../types";

interface SimVector {
  momentum24h: number;
  volumeAccel: number;
  liqLog: number;
  mcapLog: number;
  holderGrowth: number;
  top10: number;
  ageLog: number;
}

function toVec(f: FeatureVector, mcap: number): SimVector {
  return {
    momentum24h: Math.tanh(f.momentum24h / 50),
    volumeAccel: Math.tanh(Math.log2(Math.max(f.volumeAccel, 0.1)) / 3),
    liqLog: Math.log10(Math.max(f.liquidityUsd, 1)) / 7,
    mcapLog: Math.log10(Math.max(mcap, 1)) / 9,
    holderGrowth: Math.tanh(f.holderGrowthPct / 25),
    top10: f.top10Pct,
    ageLog: Math.log10(Math.max(f.ageHours, 1)) / 3.5,
  };
}

function dist(a: SimVector, b: SimVector): number {
  const keys = Object.keys(a) as (keyof SimVector)[];
  let s = 0;
  for (const k of keys) s += (a[k] - b[k]) ** 2;
  return Math.sqrt(s / keys.length);
}

export interface SimilarSetup {
  mint: string;
  symbol: string;
  ts: number;
  distance: number;
  outcome24hPct: number;
  outcome72hPct: number;
}

export interface SimilarityReport {
  samples: number;
  median24h: number;
  p10_24h: number;
  p90_24h: number;
  matches: SimilarSetup[];
}

export function findSimilar(store: DemoStore, mint: string, asOf?: number, limit = 8): SimilarityReport | undefined {
  const now = asOf ?? store.simulatedUntil;
  const f = extractFeatures(store, mint, now);
  const snap = store.snapshot(mint, now);
  if (!f || !snap) return undefined;
  const target = toVec(f, snap.marketCapUsd);

  const matches: SimilarSetup[] = [];
  for (const tok of store.tokenList()) {
    if (tok.info.mint === mint) continue;
    // sample that token's history every 12h, needing 72h of future for outcomes
    const usable = tok.candles.length - 72;
    for (let i = 48; i < usable; i += 12) {
      const ts = tok.candles[i].t;
      if (ts > now - 3 * DAY) continue; // outcomes must be fully in the past
      const hf = extractFeatures(store, tok.info.mint, ts);
      if (!hf) continue;
      const hSnap = store.snapshot(tok.info.mint, ts);
      if (!hSnap) continue;
      const d = dist(target, toVec(hf, hSnap.marketCapUsd));
      const p0 = tok.candles[i].c;
      const p24 = tok.candles[Math.min(tok.candles.length - 1, i + 24)].c;
      const p72 = tok.candles[Math.min(tok.candles.length - 1, i + 72)].c;
      matches.push({
        mint: tok.info.mint,
        symbol: tok.info.symbol,
        ts,
        distance: d,
        outcome24hPct: (p24 / p0 - 1) * 100,
        outcome72hPct: (p72 / p0 - 1) * 100,
      });
    }
  }
  matches.sort((a, b) => a.distance - b.distance);
  const top = matches.slice(0, Math.max(limit, 20));
  if (top.length < 5) return { samples: top.length, median24h: 0, p10_24h: 0, p90_24h: 0, matches: top.slice(0, limit) };
  const rets = top.map((m) => m.outcome24hPct).sort((a, b) => a - b);
  const q = (p: number) => rets[Math.min(rets.length - 1, Math.floor(p * rets.length))];
  return {
    samples: top.length,
    median24h: q(0.5),
    p10_24h: q(0.1),
    p90_24h: q(0.9),
    matches: top.slice(0, limit),
  };
}
