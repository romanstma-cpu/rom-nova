// Does Nova actually profile a real Solana wallet, and does it stay honest
// about the half it cannot see?
//
// A fixture test proves the parser. Only this proves the design, and prior work
// in this repo was saved twice by exactly that distinction: a source that took
// 320ms alone took 27 SECONDS under fan-out, and a source that worked from Node
// returned 403 to browsers.
//
// It was also the first version's blind spot. That probe measured one endpoint
// with one header and concluded the whole app was capped at two days, when the
// SAME endpoint served 375 days to a caller that sent no Origin. So depth is
// now measured PER RUNTIME and per method, and the awkward address shapes — a
// mint, a program, an empty key — are tested rather than assumed away.

import { isPlausibleAddress } from "../src/lib/providers/wallet-chain";
import {
  MAINNET_BETA,
  PUBLICNODE,
  resolveRpcRoute,
  __setRpcRoute,
} from "../src/lib/providers/rpc-endpoint";
import { identifyAccount } from "../src/lib/providers/account-kind";
import { getSolBars } from "../src/lib/providers/sol-history";
import { walletProfile, __resetWalletCache } from "../src/lib/api/source";
import { SqdFlowProvider } from "../src/lib/providers/sqd";
import { JupiterTokenProvider } from "../src/lib/providers/jupiter";
import { dataMode } from "../src/lib/providers/registry";

const ORIGIN = "app://rom-nova";

const usd = (x: number | undefined): string =>
  x === undefined ? "UNMEASURED" : `$${x.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const pad = (s: string | number, n: number): string => String(s).padStart(n);

/**
 * Address shapes the blind review used, because every one of them broke
 * something. A mint rendered as a $520K portfolio; a never-used key produced
 * "12/31/1969"; a program wore "NO LABELS AVAILABLE".
 */
const SHAPES: { label: string; address: string; expect: string }[] = [
  { label: "token mint (ANSEM)", address: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump", expect: "mint" },
  { label: "program (Raydium AMM v4)", address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", expect: "program" },
  { label: "program (Token program)", address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", expect: "program" },
  // A valid ed25519-shaped key nobody has ever funded. `11111…12` looks like a
  // good candidate and is not one — it EXISTS, owned by the system program, so
  // it classifies as a wallet and correctly so.
  { label: "valid, never used", address: "96MEty7nyk7wEMzx1Cd65wQV3wQWvWmhHdjWmz9ynZXY", expect: "empty" },
  { label: "exchange wallet (Binance hot)", address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", expect: "wallet" },
];

/** Raw JSON-RPC with an explicit header choice — the variable that matters. */
async function rawSigs(
  endpoint: string,
  address: string,
  origin: string | null,
): Promise<{ n: number; days: number; status: string; ms: number }> {
  const t0 = Date.now();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [address, { limit: 1000 }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { n: 0, days: 0, status: `HTTP ${res.status}`, ms: Date.now() - t0 };
    const body = (await res.json()) as { result?: { blockTime: number | null }[]; error?: { message: string } };
    if (body.error) return { n: 0, days: 0, status: body.error.message.slice(0, 30), ms: Date.now() - t0 };
    const rows = body.result ?? [];
    const oldest = rows.length ? rows[rows.length - 1].blockTime : null;
    return {
      n: rows.length,
      days: oldest ? (Date.now() / 1000 - oldest) / 86_400 : 0,
      status: "ok",
      ms: Date.now() - t0,
    };
  } catch (err) {
    return { n: 0, days: 0, status: err instanceof Error ? err.message.slice(0, 30) : "threw", ms: Date.now() - t0 };
  }
}

/**
 * The measurement the first version of this probe missed entirely.
 *
 * It tested every endpoint with `Origin: app://rom-nova` set — correct for the
 * browser build, and it silently answered the question for all three runtimes.
 * Node and the desktop main process send no Origin at all, and mainnet-beta
 * treats that completely differently.
 */
async function measureDepthPerRuntime(): Promise<void> {
  console.log("\n=== 1. DEPTH, and it depends on the ORIGIN HEADER");
  const probe = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; // quiet, years old
  console.log("  getSignaturesForAddress on a quiet years-old address:");
  for (const ep of [MAINNET_BETA, PUBLICNODE]) {
    for (const [label, origin] of [["no Origin  (node / desktop main)", null], ["app://rom-nova (a tab)", ORIGIN]] as const) {
      const r = await rawSigs(ep, probe, origin);
      console.log(
        `    ${ep.replace("https://", "").padEnd(28)} ${label.padEnd(34)} ` +
          `${r.status === "ok" ? `n=${pad(r.n, 4)} reaches ${r.days.toFixed(2).padStart(6)} days` : r.status.padEnd(24)} (${r.ms}ms)`,
      );
    }
  }
  console.log("  ^ the archive is free from Node and refuses any tab. One label over both would be false for one.");

  console.log("\n  getTransaction body retention, by age (the ceiling on every PRICE):");
  const ages = [0.5, 10, 60];
  const sigsRes = await fetch(MAINNET_BETA, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: ["9KnuodP2rR9t59zyp64HXpcGjByuJ39KBr3TXiZjxNaj", { limit: 1000 }],
    }),
  }).then((r) => r.json() as Promise<{ result?: { signature: string; blockTime: number; err: unknown }[] }>);
  const pool = (sigsRes.result ?? []).filter((s) => !s.err);
  const now = Date.now() / 1000;
  for (const days of ages) {
    const target = now - days * 86_400;
    let best = pool[0];
    let gap = Infinity;
    for (const s of pool) {
      const g = Math.abs(s.blockTime - target);
      if (g < gap) { gap = g; best = s; }
    }
    if (!best) continue;
    const age = (now - best.blockTime) / 86_400;
    const line = [`    ~${String(days).padStart(4)}d (actual ${age.toFixed(1)}d)`];
    for (const [name, ep] of [["publicnode", PUBLICNODE], ["mainnet-beta", MAINNET_BETA]] as const) {
      try {
        const res = await fetch(ep, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "getTransaction",
            params: [best.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
          }),
          signal: AbortSignal.timeout(20_000),
        });
        const body = (await res.json()) as { result?: unknown; error?: { message: string } };
        line.push(`${name}=${body.error ? "ERR" : body.result ? "OK" : "NULL"}`);
      } catch { line.push(`${name}=threw`); }
    }
    console.log(line.join("  "));
  }
  console.log("  ^ publicnode drops bodies past ~2 days; mainnet-beta keeps them and allows 10 calls per window.");
}

async function profileOne(address: string, label: string): Promise<void> {
  console.log(`\n--- ${label}`);
  console.log(`    ${address}`);
  __resetWalletCache();
  const t0 = Date.now();
  const sourced = await walletProfile(address);
  const ms = Date.now() - t0;
  if (!sourced) {
    console.log(`  no profile (${ms}ms) — Solana unreachable, or not a Solana pubkey`);
    return;
  }
  const p = sourced.data;
  const c = p.coverage;
  console.log(`  ${pad(ms, 6)}ms  ·  identity: ${p.identity.kind.toUpperCase()} — ${p.identity.detail}`);
  if (!p.identity.profilable) {
    console.log("  (correctly refused to profile as a trader)");
    return;
  }
  console.log(
    `  runtime  ${c.runtime}  ·  ${c.transactionsRead} txs read, ` +
      `${c.transactionsFailed - c.transactionsRefused} failed, ${c.transactionsRefused} rate-limited, ` +
      `${c.transactionsUnavailable} past body retention`,
  );
  console.log(
    `  fills    ${c.windowHours >= 1 ? `${c.windowHours.toFixed(1)}h` : `${Math.round(c.windowHours * 60)}min`}` +
      `  ${c.oldestTs ? new Date(c.oldestTs).toISOString().slice(0, 16) : "—"} → ${c.newestTs ? new Date(c.newestTs).toISOString().slice(0, 16) : "—"}`,
  );
  console.log(
    `  age      ${c.indexArchival ? `${c.signaturesListed.toLocaleString()} txs, first seen ` +
      `${c.firstSeenTs ? new Date(c.firstSeenTs).toISOString().slice(0, 10) : "—"} (${c.historyDays.toFixed(1)}d)` +
      `${c.indexComplete ? " COMPLETE" : " at least"}` : "NOT READABLE (browser runtime)"}`,
  );
  console.log(`  note     ${c.note}`);

  const s = p.stats;
  console.log(
    `  realized ${usd(s.realizedPnlUsd)} over ${s.roundTrips} full close(s) + ${s.partialExits} partial ` +
      `(${usd(s.partialExitPnlUsd)})  ·  win ${s.winRate === undefined ? "—" : `${(s.winRate * 100).toFixed(0)}%`}`,
  );
  if (p.holdings) {
    console.log(
      `  worth    ${usd(p.holdings.valuedUsd)} total = ${usd(p.holdings.tokenValueUsd)} tokens + ` +
        `${usd(p.holdings.solValueUsd)} in ${p.holdings.solBalance.toFixed(3)} SOL`,
    );
  }
  console.log(`  unmeasured: ${p.unmeasured.join(", ")}`);
  for (const line of p.provenance) console.log(`    · ${line}`);
}

void (async () => {
  console.log("ROM Nova — real wallet tracking probe");
  const route = await resolveRpcRoute();
  console.log(`runtime: ${route.runtime}  ·  index: ${route.signatures}  ·  bodies: ${route.transactions}`);
  console.log(`         ${route.note}`);
  const mode = dataMode();
  console.log(`data mode: ${mode.overall}`);
  for (const b of mode.bounded) console.log(`  bounded: ${b}`);

  await measureDepthPerRuntime();

  console.log("\n=== 2. ADDRESS SHAPES — a mint is not a wallet");
  for (const shape of SHAPES) {
    const id = await identifyAccount(shape.address, PUBLICNODE);
    const ok = id.kind === shape.expect;
    console.log(
      `  ${shape.label.padEnd(30)} → ${id.kind.padEnd(14)} ${ok ? "✓" : `✗ expected ${shape.expect}`}  profilable=${id.profilable}`,
    );
  }
  console.log(`  garbage input "notanaddress"       → plausible=${isPlausibleAddress("notanaddress")} (must be false)`);

  console.log("\n=== 3. SOL/USD hourly bars (fills are denominated in SOL, not dollars)");
  const t0 = Date.now();
  const bars = await getSolBars();
  if (bars.length === 0) console.log("  NO BARS — every SOL-quoted fill will come back unpriced");
  else
    console.log(
      `  ${bars.length} bars in ${Date.now() - t0}ms covering ${((bars[bars.length - 1].t - bars[0].t) / 86_400_000).toFixed(1)} days ` +
        `($${bars[0].close.toFixed(2)} → $${bars[bars.length - 1].close.toFixed(2)})`,
    );

  console.log("\n=== 4. END TO END on the awkward shapes");
  for (const shape of SHAPES) await profileOne(shape.address, shape.label);

  console.log("\n=== 5. END TO END on a real trader taken from live flow");
  let movers: string[] = [];
  try {
    const jup = new JupiterTokenProvider();
    const trending = await jup.getTrendingTokens(8);
    const pick = trending.find((t) => t.liquidityUsd > 30_000) ?? trending[0];
    const flow = await new SqdFlowProvider().getTokenFlow(pick.mint, { minutes: 8, topMovers: 14 });
    movers = [...new Set((flow?.largest ?? []).map((m) => m.owner))].filter(isPlausibleAddress);
  } catch (err) {
    // Jupiter rate-limits under a probe that has already made a hundred calls.
    // Losing the wallet SOURCE must not lose the wallet MEASUREMENTS, which are
    // what this section exists for.
    console.log(`  could not source wallets from live flow (${err instanceof Error ? err.message : err})`);
  }
  let profiled = 0;
  for (const address of movers) {
    if (profiled >= 2) break;
    const sigs = await rawSigs(PUBLICNODE, address, null);
    // A wallet with a readable window and a human shape, not an arb bot.
    if (sigs.n < 20 || sigs.n >= 1000) continue;
    profiled++;
    await profileOne(address, `trader ${profiled} (${sigs.n} recent txs)`);
  }
  if (profiled === 0) {
    console.log("  falling back to a known-shape trader so the section still measures something");
    await profileOne("9KnuodP2rR9t59zyp64HXpcGjByuJ39KBr3TXiZjxNaj", "trader (fallback)");
  }

  console.log("\n=== 6. BROWSER RUNTIME, forced — what a tab actually gets");
  __setRpcRoute({
    runtime: "browser",
    transactions: PUBLICNODE,
    signatures: PUBLICNODE,
    archivalIndex: false,
    note: "forced browser route for comparison",
  });
  __resetWalletCache();
  const t1 = Date.now();
  const browserProfile = await walletProfile("9KnuodP2rR9t59zyp64HXpcGjByuJ39KBr3TXiZjxNaj");
  if (browserProfile) {
    const c = browserProfile.data.coverage;
    console.log(
      `  ${Date.now() - t1}ms  index reached ${c.signaturesListed} signatures, archival=${c.indexArchival}, ` +
        `age readable=${c.indexArchival}`,
    );
    console.log(`  note: ${c.note}`);
  }
  __setRpcRoute(null);
})();
