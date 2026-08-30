// The scanner's WHALE 6H column reads "$0" on every row. That is either a
// measured zero (the flow read happened and nothing whale-sized moved net) or a
// zero standing in for an absence — and those look identical in a table.

import { trendingRows } from "../src/lib/api/source";

void (async () => {
  const res = await trendingRows(12);
  if (!res) return console.log("no live rows");
  for (const r of res.data) {
    const absent = (r.unmeasured ?? []).includes("whaleFlow" as never);
    console.log(
      `${r.symbol.padEnd(12)} whaleFlow=${absent ? "UNMEASURED" : r.whaleFlowUsd.toFixed(2).padStart(12)}  ` +
        `window=${r.flowMinutes ?? "—"}min complete=${r.flowComplete ?? "—"}  ` +
        `movers=${r.topWallets?.length ?? 0}  ` +
        `biggest=${r.topWallets?.[0] ? `$${r.topWallets[0].usd.toFixed(0)}` : "—"}`,
    );
  }
})();
