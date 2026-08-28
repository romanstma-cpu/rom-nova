/**
 * Which Birdeye endpoints does THIS key actually allow?
 *
 * The adapter was written against Birdeye's published paths, and the first run
 * with a real key returned nothing — which could mean the key is rejected, the
 * path has moved, the free tier excludes the endpoint, or the response shape
 * changed. Four problems, four different fixes, and no way to tell them apart
 * from "no security record".
 *
 * So this asks each endpoint directly and prints the status code and the top
 * level of whatever came back. It never prints the key.
 *
 *   npm run probe:birdeye
 */
import * as fs from "node:fs";
import * as path from "node:path";

const BASE = "https://public-api.birdeye.so";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function loadEnvLocal(): void {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/** Endpoints the app either uses or would use, cheapest first. */
const ENDPOINTS: { label: string; path: string; wants: string }[] = [
  { label: "price", path: `/defi/price?address=${BONK}`, wants: "value" },
  { label: "token_overview", path: `/defi/token_overview?address=${BONK}`, wants: "holder, liquidity, v24hUSD" },
  { label: "token_security", path: `/defi/token_security?address=${BONK}`, wants: "top10HolderPercent, ownerAddress, freezeAuthority" },
  { label: "token_creation_info", path: `/defi/token_creation_info?address=${BONK}`, wants: "owner, txHash" },
  { label: "ohlcv 1H", path: `/defi/ohlcv?address=${BONK}&type=1H&time_from=${Math.floor(Date.now() / 1000) - 86400}&time_to=${Math.floor(Date.now() / 1000)}`, wants: "items[]" },
  { label: "token_holder (v3)", path: `/defi/v3/token/holder?address=${BONK}&offset=0&limit=10`, wants: "items[] holder list" },
  { label: "holder-profile (v1)", path: `/token/v1/holder-profile?address=${BONK}`, wants: "bundler/sniper/insider/dev tags" },
  { label: "token_trade_data", path: `/defi/v3/token/trade-data/single?address=${BONK}`, wants: "buy/sell counts, unique wallets" },
];

/** Shows the shape of a response without dumping a huge object. */
function describe(v: unknown, depth = 0): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})${v.length && depth < 2 ? ` of { ${describe(v[0], depth + 1)} }` : ""}`;
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    if (depth >= 2) return `{${keys.length} keys}`;
    return keys.slice(0, 14).join(", ") + (keys.length > 14 ? `, +${keys.length - 14} more` : "");
  }
  return typeof v;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const key = process.env.BIRDEYE_API_KEY;
  console.log(`\n=== Birdeye endpoint access ===`);
  if (!key) {
    console.log("  BIRDEYE_API_KEY not set. Put it in whalenova/.env.local and re-run.\n");
    return;
  }
  // Never print the key. Length and shape are enough to spot a truncated paste.
  console.log(`  key: ${key.length} chars, ${/^[A-Za-z0-9_-]+$/.test(key) ? "plausible format" : "UNEXPECTED CHARACTERS — check for quotes or spaces"}\n`);

  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(BASE + ep.path, {
        headers: { "X-API-KEY": key, "x-chain": "solana", accept: "application/json" },
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* non-JSON error page */
      }
      const env = body as { success?: boolean; data?: unknown; message?: string } | null;
      const ok = res.ok && env?.success !== false;
      console.log(`  ${ok ? "OK  " : "FAIL"} ${String(res.status).padEnd(4)} ${ep.label.padEnd(20)}`);
      if (ok && env?.data !== undefined) {
        console.log(`         fields: ${describe(env.data)}`);
      } else if (!ok) {
        console.log(`         wanted: ${ep.wants}`);
        console.log(`         said:   ${(env?.message ?? text).slice(0, 130)}`);
      }
    } catch (e) {
      console.log(`  FAIL      ${ep.label.padEnd(20)} ${(e as Error).message.slice(0, 80)}`);
    }
    // Free tiers are rate limited; be polite so a 429 is not mistaken for a
    // permission problem.
    await new Promise((r) => setTimeout(r, 1200));
  }

  console.log(
    `\n  A 401 means the key is not being accepted. A 403 or a success:false with an\n` +
      `  upgrade message means the endpoint exists but the plan excludes it. A 404\n` +
      `  means the path moved. Only the first needs a new key.\n`,
  );
}

void main();
