// End-to-end check of the provider seam: does handleCandles actually return
// real GeckoTerminal bars for a real mint, and honestly-labelled simulator bars
// for a synthetic one?
//
// Unit tests prove the routing and the labels with a fake adapter; the smoke
// test proves the adapter fetches. This proves the composition, which is where
// the two would otherwise be assumed to meet.

import { handleCandles } from "../src/lib/api/handlers";
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
  console.log(`market provider resolved to: ${getProviders().market.name}`);
  await show("REAL MINT (BONK)", BONK);
  const demoMint = getStore().tokenList()[0].info.mint;
  await show(`DEMO MINT (${demoMint.slice(0, 10)}…)`, demoMint);
})();
