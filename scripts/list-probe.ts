// How long does a SCORED live token list actually take?
//
// liveFeatures refuses to build a vector without candles — "rather than emit a
// vector whose zeros mean flat, refuse" — so every scored row costs a token
// fetch plus an OHLCV fetch. The smoke test measured one candle call at 4.4s,
// which would make a serial list of twenty tokens a minute and a half.
//
// This measures the real cost at a few concurrency levels before any design is
// committed to, because the answer decides whether a live list can be the
// default or has to be asked for.

import { getProviders } from "../src/lib/providers/registry";
import { liveSignal } from "../src/lib/engine/live-features";

async function pooled<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

void (async () => {
  const p = getProviders();
  console.log(`token=${p.token.name}  market=${p.market.name}\n`);

  const t0 = Date.now();
  const trending = await p.token.getTrendingTokens(12);
  console.log(`getTrendingTokens(12): ${Date.now() - t0}ms -> ${trending.length} snapshots`);
  console.log(`  (this alone is enough for real market columns, unscored)\n`);

  for (const concurrency of [4, 8]) {
    const start = Date.now();
    const results = await pooled(trending, concurrency, async (s) => {
      const r0 = Date.now();
      try {
        const sig = await liveSignal(s.mint, { token: p.token, market: p.market });
        return { ok: Boolean(sig), ms: Date.now() - r0 };
      } catch {
        return { ok: false, ms: Date.now() - r0 };
      }
    });
    const scored = results.filter((r) => r.ok).length;
    const each = results.map((r) => r.ms).sort((a, b) => a - b);
    console.log(
      `concurrency ${concurrency}: ${Date.now() - start}ms total · ${scored}/${trending.length} scored · ` +
        `per-token median ${each[Math.floor(each.length / 2)]}ms max ${each[each.length - 1]}ms`,
    );
  }
})();
