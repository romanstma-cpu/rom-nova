// Can Nova read mint and freeze authority for itself, keyless, from a browser?
//
// Every keyless provider in this stack reports both authorities as NOT revoked,
// and live-features grades that honestly: "a token nobody has checked is never
// graded as safely renounced." Correct as a default, and wrong as a fact —
// BONK has renounced both, and the app currently marks it as if it had not.
//
// Solana's own JSON-RPC answers this with getAccountInfo + jsonParsed, no key.
// The question is whether the STATIC build can call it: romapps.xyz/nova runs
// entirely in the visitor's browser, so an endpoint without CORS is useless
// there however well it works from Node.

const ENDPOINTS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
];

const MINTS: Record<string, string> = {
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  WSOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

interface ParsedMint {
  decimals: number;
  freezeAuthority: string | null;
  mintAuthority: string | null;
  supply: string;
}

async function getMint(endpoint: string, mint: string) {
  const t0 = Date.now();
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [mint, { encoding: "jsonParsed" }],
    }),
  });
  const ms = Date.now() - t0;
  const cors = res.headers.get("access-control-allow-origin");
  if (!res.ok) return { ms, cors, error: `HTTP ${res.status}` };
  const body = (await res.json()) as {
    result?: { value?: { data?: { parsed?: { info?: ParsedMint; type?: string } } } };
    error?: { message?: string };
  };
  if (body.error) return { ms, cors, error: body.error.message ?? "rpc error" };
  const parsed = body.result?.value?.data?.parsed;
  if (parsed?.type !== "mint" || !parsed.info) return { ms, cors, error: "not a mint account" };
  return { ms, cors, info: parsed.info };
}

/** The provider as the app will actually use it, end to end. */
async function throughProvider(): Promise<void> {
  const { SolanaRpcSecurityProvider } = await import("../src/lib/providers/solana-rpc");
  const { liveSignal } = await import("../src/lib/engine/live-features");
  const { getProviders } = await import("../src/lib/providers/registry");
  const p = getProviders();
  const sec = new SolanaRpcSecurityProvider();

  console.log(`\n=== through SolanaRpcSecurityProvider`);
  for (const [name, mint] of Object.entries(MINTS)) {
    const r = await sec.getTokenSecurity(mint).catch((e) => ({ err: String(e) }) as never);
    console.log(`  ${name.padEnd(5)} ${JSON.stringify(r)}`);
  }

  console.log(`\n=== does a scored token now KNOW its authorities?`);
  const scored = await liveSignal(MINTS.BONK, { token: p.token, market: p.market, security: sec });
  if (!scored) {
    console.log("  no signal (candles unavailable right now)");
    return;
  }
  const unmeasured = scored.result.features.unmeasured ?? [];
  console.log(`  score ${scored.signal.score}  confidence ${scored.signal.confidence}`);
  console.log(`  mintAuthorityRevoked=${scored.result.info.mintAuthorityRevoked}`);
  console.log(`  freezeAuthorityRevoked=${scored.result.info.freezeAuthorityRevoked}`);
  console.log(`  top10Pct still unmeasured: ${unmeasured.includes("top10Pct")}`);
  for (const line of scored.result.provenance) console.log(`    · ${line}`);
}

void (async () => {
  for (const endpoint of ENDPOINTS) {
    console.log(`\n=== ${endpoint}`);
    for (const [name, mint] of Object.entries(MINTS)) {
      try {
        const r = await getMint(endpoint, mint);
        if (r.error) {
          console.log(`  ${name.padEnd(5)} FAILED ${r.error}  (${r.ms}ms)`);
          continue;
        }
        const i = r.info!;
        console.log(
          `  ${name.padEnd(5)} mintAuth=${String(i.mintAuthority === null ? "REVOKED" : "LIVE").padEnd(7)} ` +
            `freezeAuth=${String(i.freezeAuthority === null ? "REVOKED" : "LIVE").padEnd(7)} ` +
            `decimals=${String(i.decimals).padStart(2)}  (${r.ms}ms)  CORS=${r.cors ?? "none"}`,
        );
      } catch (e) {
        console.log(`  ${name.padEnd(5)} THREW ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  await throughProvider();
})();
