// Two specific doubts from the verdict sweep:
//
//   CATE renders POSITIVE, and a previous review found its deployer had issued
//   19,042 mints. Routing deployer history into the risk model was a round-3
//   item; if the label is still POSITIVE, either the factor is not firing or it
//   is firing too weakly to matter.
//
//   cbBTC renders EXTREME RISK. Coinbase's wrapped BTC retains its mint
//   authority BY DESIGN, exactly as USDC does. A rule that fails safe will flag
//   legitimate wrapped assets, and that is a real cost worth stating rather
//   than discovering later.

import { getProviders } from "../src/lib/providers/registry";
import { liveSignal } from "../src/lib/engine/live-features";

const TARGETS = process.argv.slice(2);

void (async () => {
  const p = getProviders();
  for (const mint of TARGETS) {
    const sig = await liveSignal(
      mint,
      { token: p.token, market: p.market, security: p.security, flow: p.flow, risk: p.risk },
      "balanced",
      Date.now(),
      true,
    );
    if (!sig) {
      console.log(`\n${mint}: no vector`);
      continue;
    }
    const s = sig.signal;
    const info = sig.result.info;
    console.log(`\n=== ${info.symbol} (${mint.slice(0, 8)}…)`);
    console.log(`    ${s.label}  score ${s.score.toFixed(0)}  conf ${s.confidence.toFixed(2)}`);
    console.log(`    devMints=${info.devMints ?? "—"} devMigrations=${info.devMigrations ?? "—"}`);
    console.log(`    mintRevoked=${info.mintAuthorityRevoked} freezeRevoked=${info.freezeAuthorityRevoked}`);
    if (s.noTradeReason) console.log(`    abstain: ${s.noTradeReason.slice(0, 130)}`);
    console.log("    risk factors:");
    for (const f of s.factors.filter((x) => x.weight <= 0 && x.contribution !== 0)) {
      console.log(`      ${f.key.padEnd(20)} ${f.contribution.toFixed(1).padStart(6)}  ${f.explanation.slice(0, 80)}`);
    }
    const stood = s.factors.filter((x) => x.weight === 0 && x.contribution === 0).map((x) => x.key);
    console.log(`    stood down: ${stood.join(", ") || "none"}`);
    console.log(`    risk flags: ${s.risks.map((r) => `${r.key}(${r.severity})`).join(", ") || "none"}`);
  }
})();
