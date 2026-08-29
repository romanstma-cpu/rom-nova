// Does Nova actually profile a real Solana wallet, and does it stay honest
// about the half it cannot see?
//
// A fixture test proves the parser. Only this proves the design, and prior work
// in this repo was saved twice by exactly that distinction: a source that took
// 320ms alone took 27 SECONDS under fan-out, and a source that worked from Node
// returned 403 to browsers.
//
// Four things get measured here, in order of how badly getting them wrong would
// hurt:
//
//   1. RETENTION. The whole product claim is bounded by it. If the only keyless
//      endpoint retains two days, "lifetime PnL" is not on the menu and the app
//      must never imply it is.
//   2. LATENCY end to end, on wallets picked from live flow rather than chosen
//      because they behave.
//   3. COVERAGE — what share of a wallet's movements carried a price at all.
//   4. RECONCILIATION — do the observed fills explain the balance the chain
//      reports? Where they do not, the cost basis must come back UNKNOWN rather
//      than confident.

import { ChainWalletProvider, HISTORY_RPC, isPlausibleAddress } from "../src/lib/providers/wallet-chain";
import { JupiterHoldingsProvider } from "../src/lib/providers/holdings";
import { getSolBars } from "../src/lib/providers/sol-history";
import { walletProfile, __resetWalletCache } from "../src/lib/api/source";
import { SqdFlowProvider } from "../src/lib/providers/sqd";
import { JupiterTokenProvider } from "../src/lib/providers/jupiter";
import { dataMode } from "../src/lib/providers/registry";

const ORIGIN = "app://rom-nova";

const usd = (x: number | undefined): string =>
  x === undefined ? "UNMEASURED" : `$${x.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const pad = (s: string | number, n: number): string => String(s).padStart(n);

interface Candidate {
  address: string;
  signatures: number;
  spanHours: number;
  kind: "retail" | "high-frequency";
}

/**
 * Real traders, taken from live flow on a trending token.
 *
 * Hand-picking wallets is how a probe ends up proving that the code works on
 * the four addresses it was written against.
 *
 * They are then SORTED, because the two kinds behave completely differently
 * and both need proving. A retail wallet carries tens to low hundreds of
 * transactions across a couple of days and profiles completely. A
 * high-frequency wallet carries thousands inside a few minutes, cannot be
 * covered by any budget, and exists in this probe to prove that the coverage
 * block says so instead of quietly reporting four minutes as a career.
 */
async function findWallets(): Promise<{ symbol: string; mint: string; candidates: Candidate[] }> {
  const jup = new JupiterTokenProvider();
  const trending = await jup.getTrendingTokens(8);
  const pick = trending.find((t) => t.liquidityUsd > 30_000) ?? trending[0];
  const info = await jup.getToken(pick.mint);
  const flow = await new SqdFlowProvider().getTokenFlow(pick.mint, { minutes: 8, topMovers: 14 });
  const movers = [...new Set((flow?.largest ?? []).map((m) => m.owner))].filter(isPlausibleAddress);

  const candidates: Candidate[] = [];
  for (const address of movers.slice(0, 12)) {
    try {
      const res = await fetch(HISTORY_RPC, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getSignaturesForAddress",
          params: [address, { limit: 1000 }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { result?: { blockTime: number | null }[] };
      const rows = (body.result ?? []).filter((r) => r.blockTime !== null);
      if (rows.length === 0) continue;
      const spanHours = ((rows[0].blockTime as number) - (rows[rows.length - 1].blockTime as number)) / 3600;
      // One page that did not fill, spread over more than an hour, is a human.
      const retail = rows.length < 1000 && spanHours > 1;
      candidates.push({
        address,
        signatures: rows.length,
        spanHours,
        kind: retail ? "retail" : "high-frequency",
      });
    } catch {
      // A screening failure just means one fewer candidate.
    }
  }
  return { symbol: info?.symbol ?? "?", mint: pick.mint, candidates };
}

/** The claim everything else is bounded by, measured rather than assumed. */
async function measureRetention(): Promise<void> {
  console.log("\n=== 1. RETENTION — how far back can a keyless read reach?");
  // A quiet, long-lived address. If the endpoint had full history this would
  // return signatures from years ago; a two-day floor is a retention edge.
  const probe = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const endpoints = [
    HISTORY_RPC,
    "https://api.mainnet-beta.solana.com",
    "https://rpc.ankr.com/solana",
    "https://solana.drpc.org",
    "https://solana.blockpi.network/v1/rpc/public",
  ];
  for (const ep of endpoints) {
    const t0 = Date.now();
    try {
      const res = await fetch(ep, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getSignaturesForAddress",
          params: [probe, { limit: 1000 }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const cors = res.headers.get("access-control-allow-origin") ?? "NONE";
      if (!res.ok) {
        console.log(`  ${ep.padEnd(46)} HTTP ${res.status}  cors=${cors}`);
        continue;
      }
      const body = (await res.json()) as { result?: { blockTime: number | null }[]; error?: { message: string } };
      if (body.error) {
        console.log(`  ${ep.padEnd(46)} RPC ERROR ${body.error.message.slice(0, 50)}  cors=${cors}`);
        continue;
      }
      const rows = body.result ?? [];
      const oldest = rows.length ? rows[rows.length - 1].blockTime : null;
      const days = oldest ? (Date.now() / 1000 - oldest) / 86_400 : 0;
      console.log(
        `  ${ep.padEnd(46)} n=${pad(rows.length, 4)}  reaches back ${days.toFixed(2)} days  cors=${cors}  ${Date.now() - t0}ms`,
      );
    } catch (err) {
      console.log(`  ${ep.padEnd(46)} ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("  ^ anything under ~3 days on a years-old address is the ENDPOINT stopping, not the wallet");
}

async function profileOne(address: string): Promise<void> {
  console.log(`\n--- ${address}`);
  __resetWalletCache();
  const t0 = Date.now();
  const sourced = await walletProfile(address);
  const ms = Date.now() - t0;
  if (!sourced) {
    console.log(`  no profile (${ms}ms) — no live wallet source, or not a Solana pubkey`);
    return;
  }
  const p = sourced.data;
  const c = p.coverage;
  console.log(
    `  ${pad(ms, 6)}ms end to end  ·  ${c.transactionsRead} txs read, ` +
      `${c.transactionsFailed - c.transactionsRefused} failed, ${c.transactionsRefused} rate-limited, ` +
      `${c.signaturesListed} signatures listed`,
  );
  console.log(
    `  window   ${c.windowHours >= 1 ? `${c.windowHours.toFixed(1)}h` : `${Math.round(c.windowHours * 60)}min`}` +
      `  ${new Date(c.oldestTs).toISOString().slice(0, 16)} → ${new Date(c.newestTs).toISOString().slice(0, 16)}` +
      `  capped=${c.cappedByBudget} endpointLimit=${c.reachedEndpointLimit} lifetime=${c.lifetime}`,
  );
  console.log(`  note     ${c.note}`);

  const s = p.stats;
  console.log(
    `  fills    ${s.buys} buys / ${s.sells} sells across ${s.distinctMints} mints  ·  ` +
      `PRICED ${s.pricedFills}, UNPRICED ${s.unpricedFills}` +
      (s.pricedFills + s.unpricedFills > 0
        ? ` (${((s.pricedFills / (s.pricedFills + s.unpricedFills)) * 100).toFixed(0)}% priced)`
        : ""),
  );
  console.log(
    `  realized ${usd(s.realizedPnlUsd)}  over ${s.roundTrips} round trip(s)  ·  ` +
      `win ${s.winRate === undefined ? "UNMEASURED" : `${(s.winRate * 100).toFixed(0)}%`}  ` +
      `PF ${s.profitFactor === undefined ? "UNMEASURED" : s.profitFactor.toFixed(2)}  ` +
      `median hold ${s.medianHoldHours === undefined ? "UNMEASURED" : `${s.medianHoldHours.toFixed(1)}h`}`,
  );
  if (s.unmatchedSellMints > 0) {
    console.log(
      `  unmatched ${s.unmatchedSellTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens sold ` +
        `across ${s.unmatchedSellMints} mint(s) with no observed buy — EXCLUDED from realized PnL`,
    );
  }
  if (p.holdings) {
    console.log(
      `  holds    ${p.holdings.solBalance.toFixed(3)} SOL  ·  ${p.holdings.mints} mints  ·  ` +
        `${usd(p.holdings.valuedUsd)} across ${p.holdings.pricedMints} priced, ${p.holdings.unpricedMints} unpriced`,
    );
  } else {
    console.log("  holds    BALANCE READ FAILED — positions are fill-derived only");
  }
  console.log(`  unmeasured: ${p.unmeasured.join(", ")}`);

  const known = p.positions.filter((x) => x.costBasisKnown).length;
  console.log(`  positions ${p.positions.length}  ·  cost basis KNOWN on ${known}, UNKNOWN on ${p.positions.length - known}`);
  for (const pos of p.positions.slice(0, 5)) {
    console.log(
      `    ${pos.mint.slice(0, 10)}…  ${pad(pos.tokens.toLocaleString(undefined, { maximumFractionDigits: 2 }), 16)} tok  ` +
        `value ${pad(usd(pos.valueUsd), 12)}  ` +
        (pos.costBasisKnown
          ? `cost ${usd(pos.costBasisUsd)}  uPnL ${usd(pos.unrealizedPnlUsd)}`
          : `cost UNKNOWN — ${pos.reason}`),
    );
  }
  for (const line of p.provenance) console.log(`    · ${line}`);
}

/**
 * Are the derived fill prices real numbers?
 *
 * A price recovered from balance deltas can be plausible and wrong — one
 * misread decimal moves it by three orders of magnitude and nothing in a
 * fixture would notice. Recent fills should sit near the token's current
 * price; a fill priced 1000x off is a parser bug wearing a dollar sign.
 */
async function sanityCheckPrices(address: string): Promise<void> {
  const chain = new ChainWalletProvider();
  const activity = await chain.getActivity(address, { maxTransactions: 200 });
  if (!activity) return console.log("  no activity");
  const priced = activity.fills.filter((f) => f.priceUsd !== undefined);
  if (priced.length === 0) return console.log("  no priced fills to check");
  const mints = [...new Set(priced.map((f) => f.mint))].slice(0, 20);
  const now = await new JupiterHoldingsProvider().priceMints(mints);
  console.log(`  ${priced.length} priced fills across ${mints.length} mints`);
  let checked = 0;
  let wild = 0;
  for (const f of priced.slice(-14)) {
    const ref = now.get(f.mint);
    if (ref === undefined || ref <= 0) continue;
    checked++;
    const ratio = (f.priceUsd as number) / ref;
    if (ratio > 20 || ratio < 0.05) wild++;
    console.log(
      `    ${new Date(f.ts).toISOString().slice(11, 16)} ${f.side.toUpperCase().padEnd(4)} ` +
        `${f.mint.slice(0, 8)}  fill $${(f.priceUsd as number).toExponential(3)}  now $${ref.toExponential(3)}  ` +
        `ratio ${ratio.toFixed(3)}  via ${f.pricing}`,
    );
  }
  console.log(
    `  ${checked} comparable, ${wild} more than 20x from the current price` +
      (wild > 0 ? "  ← investigate: a decimals or leg-pairing bug looks exactly like this" : "  ← consistent"),
  );
}

void (async () => {
  console.log("ROM Nova — real wallet tracking probe");
  console.log(`history endpoint: ${HISTORY_RPC}`);
  const mode = dataMode();
  console.log(`data mode: ${mode.overall}`);
  console.log(`  live:      ${mode.live.join(", ")}`);
  console.log(`  bounded:   ${mode.bounded.join(" | ") || "none"}`);
  console.log(`  simulated: ${mode.simulated.join(", ")}`);

  await measureRetention();

  console.log("\n=== 2. SOL/USD hourly bars (fills are denominated in SOL, not dollars)");
  const t0 = Date.now();
  const bars = await getSolBars();
  if (bars.length === 0) {
    console.log("  NO BARS — every SOL-quoted fill will come back unpriced");
  } else {
    const span = (bars[bars.length - 1].t - bars[0].t) / 86_400_000;
    console.log(
      `  ${bars.length} bars in ${Date.now() - t0}ms covering ${span.toFixed(1)} days  ` +
        `($${bars[0].close.toFixed(2)} → $${bars[bars.length - 1].close.toFixed(2)})`,
    );
  }

  console.log("\n=== 3. END TO END on wallets taken from live flow");
  const found = await findWallets();
  console.log(`  trending token: ${found.symbol} (${found.mint.slice(0, 10)}…)`);
  for (const c of found.candidates) {
    console.log(
      `    ${c.address}  ${pad(c.signatures, 5)} sigs over ${pad(c.spanHours.toFixed(1), 6)}h  → ${c.kind}`,
    );
  }
  // Busiest retail first. A wallet with five transactions cannot have closed a
  // round trip, so profiling it proves the plumbing and never exercises the
  // realized-PnL path — which is the number most worth being right about.
  const retail = found.candidates
    .filter((c) => c.kind === "retail")
    .sort((a, b) => b.signatures - a.signatures)
    .slice(0, 2);
  const hot = found.candidates.filter((c) => c.kind === "high-frequency").slice(0, 1);
  if (retail.length === 0) console.log("  (no retail-shaped wallet in this sample — the honesty path is still exercised below)");
  for (const c of [...retail, ...hot]) {
    console.log(`\n  [${c.kind}]`);
    await profileOne(c.address);
  }

  console.log("\n=== 4. PRICE SANITY — derived fill prices vs the current price");
  const forSanity = retail[0] ?? hot[0] ?? found.candidates[0];
  if (forSanity) await sanityCheckPrices(forSanity.address);
})();
