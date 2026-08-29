// End-to-end check of the provider seam: does handleCandles actually return
// real GeckoTerminal bars for a real mint, and honestly-labelled simulator bars
// for a synthetic one?
//
// Unit tests prove the routing and the labels with a fake adapter; the smoke
// test proves the adapter fetches. This proves the composition, which is where
// the two would otherwise be assumed to meet.

import { handleCandles, handleTokens } from "../src/lib/api/handlers";
import { getStore } from "../src/lib/demo/store";
import { getProviders } from "../src/lib/providers/registry";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

async function show(label: string, mint: string): Promise<void> {
  try {
    const r = await handleCandles(getStore(), mint);
    const first = r.candles[0];
    const last = r.candles[r.candles.length - 1];
    console.log(`\n${label}`);
    console.log(`  source     ${r.provenance.source}  real=${r.provenance.real}  demo=${r.demo}`);
    if (r.provenance.note) console.log(`  note       ${r.provenance.note}`);
    console.log(`  bars       ${r.candles.length}`);
    console.log(
      `  span       ${new Date(first.t).toISOString().slice(0, 16)} -> ${new Date(last.t).toISOString().slice(0, 16)}`,
    );
    console.log(`  last close ${last.c}`);
  } catch (err) {
    console.log(`\n${label}\n  threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

void (async () => {
  const p = getProviders();
  console.log(`token=${p.token.name}  market=${p.market.name}`);
  await show("REAL MINT (BONK)", BONK);
  const demoMint = getStore().tokenList()[0].info.mint;
  await show(`DEMO MINT (${demoMint.slice(0, 10)}…)`, demoMint);

  const t0 = Date.now();
  const list = await handleTokens(getStore(), { limit: 12 });
  console.log(`\nTOKEN LIST  (${Date.now() - t0}ms)`);
  console.log(`  source ${list.provenance.source}  real=${list.provenance.real}  rows=${list.rows.length}`);
  for (const r of list.rows.slice(0, 6)) {
    console.log(
      `  ${(r.symbol || "?").padEnd(10)} ${r.mint.slice(0, 8)}…  ` +
        `$${r.priceUsd.toPrecision(4).padStart(12)}  liq $${Math.round(r.liquidityUsd).toLocaleString().padStart(12)}  ` +
        `vol24 $${Math.round(r.volume24hUsd).toLocaleString().padStart(13)}  scored=${r.scored}`,
    );
  }
  const unscored = list.rows.filter((r) => !r.scored).length;
  console.log(`  unscored: ${unscored}/${list.rows.length}`);

  console.log(`\n  SCORES — is the confidence honest about what stood down?`);
  for (const r of list.rows.slice(0, 5)) {
    console.log(
      `  ${(r.symbol || "?").padEnd(10)} score ${String(r.signalScore).padStart(3)}  ` +
        `conf ${r.confidence.toFixed(2)}  risk ${r.riskLevel.padEnd(6)}  ` +
        `unmeasured: ${(r.unmeasured ?? []).join(", ") || "none"}`,
    );
  }
})();
