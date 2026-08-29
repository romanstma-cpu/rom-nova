// Does the flow provider produce real wallet movement, and does it stay honest
// when the window is too big to read?
//
// Two cases on purpose. A trending memecoin should complete inside the byte
// budget and report a full window. Wrapped SOL, the busiest mint on the chain,
// must NOT — it has to hit the budget, stop, and report `complete: false` with
// the blocks it actually covered. A provider that returns a tidy number for
// wSOL is a provider that silently truncated.

import { SqdFlowProvider, coveragePct, toUnits } from "../src/lib/providers/sqd";
import { getProviders } from "../src/lib/providers/registry";

const WSOL = "So11111111111111111111111111111111111111112";

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

async function show(label: string, mint: string, decimals: number, minutes: number): Promise<void> {
  const t0 = Date.now();
  const flow = await new SqdFlowProvider().getTokenFlow(mint, { minutes });
  console.log(`\n=== ${label}  (${mint.slice(0, 10)}…, asked ${minutes} min)`);
  if (!flow) {
    console.log("  no flow returned");
    return;
  }
  console.log(`  took            ${Date.now() - t0}ms, read ${(flow.bytesRead / 1024 / 1024).toFixed(1)}MB`);
  console.log(
    `  window          ${flow.complete ? "COMPLETE" : "PARTIAL"} — covered ${flow.blocksCovered}/${flow.blocksRequested} blocks (${coveragePct(flow).toFixed(0)}%)`,
  );
  console.log(`  movements       ${fmt(flow.movements)}  (discarded ${fmt(flow.touchedNotMoved)} touched-not-moved)`);
  console.log(`  wallets         ${fmt(flow.wallets)}  ${flow.buyers} buying / ${flow.sellers} selling`);
  console.log(`  net             ${fmt(toUnits(flow.netUnits, decimals))} tokens`);
  console.log(`    in  ${fmt(toUnits(flow.inflowUnits, decimals))}   out ${fmt(toUnits(flow.outflowUnits, decimals))}`);
  console.log(`  biggest movers:`);
  for (const m of flow.largest.slice(0, 4)) {
    const u = toUnits(m.deltaUnits, decimals);
    console.log(`    ${m.owner.slice(0, 12)}…  ${u >= 0 ? "+" : ""}${fmt(u)}`);
  }
}

void (async () => {
  // A real trending token from the app's own list, not a hand-picked one.
  const trending = await getProviders().token.getTrendingTokens(6);
  const pick = trending.find((t) => t.liquidityUsd > 20_000) ?? trending[0];
  if (pick) {
    const info = await getProviders().token.getToken(pick.mint);
    await show(`TRENDING: ${info?.symbol ?? "?"}`, pick.mint, info?.decimals ?? 9, 10);
  } else {
    console.log("no trending token available to probe");
  }

  await show("WORST CASE: wSOL", WSOL, 9, 10);
})();
