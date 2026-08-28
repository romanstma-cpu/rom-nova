/**
 * Does the keyless stack actually return Solana data?
 *
 * Typechecking proves the adapters compile against the interfaces. It says
 * nothing about whether the endpoints answer, whether the field names still
 * match, or whether the OHLCV that unblocks the backtester really arrives. So
 * this calls every method against the live APIs and prints what came back.
 *
 *   npx esbuild scripts/provider-smoke.ts --bundle --platform=node \
 *     --outfile=node_modules/.cache/smoke.cjs --log-level=error
 *   node node_modules/.cache/smoke.cjs
 */
import { DexScreenerTokenProvider, DexScreenerMarketProvider } from "../src/lib/providers/dexscreener";
import {
  GeckoTerminalTokenProvider,
  GeckoTerminalMarketProvider,
} from "../src/lib/providers/geckoterminal";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const usd = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;

async function step<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  const t0 = Date.now();
  try {
    const out = await run();
    console.log(`  OK   ${label}  (${Date.now() - t0}ms)`);
    return out;
  } catch (e) {
    console.log(`  FAIL ${label}  ${(e as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  console.log("\n=== DEX Screener (keyless) ===");
  const dexTok = new DexScreenerTokenProvider();
  const dexMkt = new DexScreenerMarketProvider();

  const t = await step("getToken(BONK)", () => dexTok.getToken(BONK));
  if (t) {
    console.log(
      `       ${t.name} (${t.symbol}) narrative=${t.narrative} verified=${t.verified}\n` +
        `       price ${t.snapshot.priceUsd} liq ${usd(t.snapshot.liquidityUsd)} ` +
        `vol24 ${usd(t.snapshot.volume24hUsd)} buys/sells 1h ${t.snapshot.buys1h}/${t.snapshot.sells1h}`,
    );
    console.log(`       unmeasured: ${t.snapshot.unmeasured?.length ?? 0} fields declared`);
  }

  const trend = await step("getTrendingTokens(5)", () => dexTok.getTrendingTokens(5));
  if (trend) console.log(`       ${trend.length} snapshots, first priced ${trend[0]?.priceUsd ?? "-"}`);

  const found = await step('searchTokens("bonk")', () => dexTok.searchTokens("bonk"));
  if (found) console.log(`       ${found.length} results, first ${found[0]?.symbol ?? "-"}`);

  const px = await step("getPrice(BONK)", () => dexMkt.getPrice(BONK));
  console.log(`       price ${px}`);

  console.log("\n=== GeckoTerminal / CoinGecko on-chain (keyless) ===");
  const gtTok = new GeckoTerminalTokenProvider();
  const gtMkt = new GeckoTerminalMarketProvider();

  const gt = await step("getToken(BONK)", () => gtTok.getToken(BONK));
  if (gt) {
    console.log(
      `       ${gt.name} (${gt.symbol}) narrative=${gt.narrative} verified=${gt.verified}\n` +
        `       price ${gt.snapshot.priceUsd} liq ${usd(gt.snapshot.liquidityUsd)} ` +
        `mcap ${usd(gt.snapshot.marketCapUsd)} buys/sells 1h ${gt.snapshot.buys1h}/${gt.snapshot.sells1h}`,
    );
  }

  // The one that matters: real history.
  const to = Date.now();
  const from = to - 30 * 86_400_000;
  const candles = await step("getCandles(BONK, 30d)", () => gtMkt.getCandles(BONK, from, to));
  if (candles && candles.length) {
    const span = (candles[candles.length - 1].t - candles[0].t) / 86_400_000;
    console.log(
      `       ${candles.length} bars spanning ${span.toFixed(1)} days\n` +
        `       oldest ${new Date(candles[0].t).toISOString().slice(0, 16)} o=${candles[0].o.toExponential(3)}\n` +
        `       newest ${new Date(candles[candles.length - 1].t).toISOString().slice(0, 16)} c=${candles[candles.length - 1].c.toExponential(3)}`,
    );
    const ascending = candles.every((c, i) => i === 0 || c.t >= candles[i - 1].t);
    const sane = candles.every((c) => c.h >= c.l && c.h >= c.c && c.l <= c.c && c.v >= 0);
    console.log(`       ascending in time: ${ascending}   high/low/close consistent: ${sane}`);
  } else {
    console.log("       NO CANDLES — the backtester stays on the simulator");
  }

  const gtTrend = await step("getTrendingTokens(5)", () => gtTok.getTrendingTokens(5));
  if (gtTrend) {
    console.log(`       ${gtTrend.length} snapshots`);
    for (const s of gtTrend.slice(0, 3)) {
      console.log(`         ${s.mint.slice(0, 10)}…  ${usd(s.liquidityUsd)} pooled  vol24 ${usd(s.volume24hUsd)}`);
    }
  }
  console.log("");
}

void main();
