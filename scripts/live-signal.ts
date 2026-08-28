/**
 * Point the signal engine at a REAL Solana token and print what it says.
 *
 * This is the experiment the whole provider effort was for. Every ROM Nova
 * number to date has measured `demo/simulator.ts` — a generator that labels
 * its own tokens "rug" and "fader" and then produces price paths from those
 * labels. Signals fitted to that are fitted to the generator. Until now there
 * was no way to ask the only question that matters: does the engine say
 * anything useful about a token it has never seen and nobody designed?
 *
 * Prints the factor breakdown including the factors that DROPPED OUT, because
 * a score built from seven of eleven inputs is a weaker claim than the same
 * number built from all of them, and the difference has to be visible.
 *
 *   npm run probe:live -- <mint> [profile]
 *
 * With no BIRDEYE_API_KEY it runs keyless and holder data stays unmeasured —
 * which will usually push the engine to NO TRADE, and that is the correct
 * answer rather than a failure.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { GeckoTerminalMarketProvider } from "../src/lib/providers/geckoterminal";
import { DexScreenerTokenProvider } from "../src/lib/providers/dexscreener";
import { BirdeyeSecurityProvider } from "../src/lib/providers/birdeye";
import { liveSignal } from "../src/lib/engine/live-features";
import type { StrategyProfileId } from "../src/lib/types";

const MINTS: Record<string, string> = {
  bonk: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  jup: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  wif: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
};

/**
 * Loads .env.local without a dependency.
 *
 * Next reads it automatically; a bundled node script does not, and adding
 * dotenv just for this would pull a package in to parse eight lines. Values
 * already in the environment win, so an exported key is not overwritten by a
 * stale file.
 */
function loadEnvLocal(): void {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const bar = (n: number, width = 22) => {
  const filled = Math.round(Math.max(0, Math.min(1, n)) * width);
  return "█".repeat(filled) + "·".repeat(width - filled);
};

async function main(): Promise<void> {
  loadEnvLocal();
  const arg = (process.argv[2] ?? "bonk").toLowerCase();
  const mint = MINTS[arg] ?? process.argv[2];
  const profile = (process.argv[3] ?? "balanced") as StrategyProfileId;

  const hasKey = Boolean(process.env.BIRDEYE_API_KEY);
  console.log(`\n=== live signal: ${mint} (${profile}) ===`);
  console.log(`  BIRDEYE_API_KEY: ${hasKey ? "present" : "NOT SET — running keyless"}\n`);

  // GeckoTerminal for history, DEX Screener for the snapshot (it sums across
  // every pool, where GT's token record is a single aggregate), Birdeye only
  // if a key exists.
  const out = await liveSignal(mint, {
    token: new DexScreenerTokenProvider(),
    market: new GeckoTerminalMarketProvider(),
    security: hasKey ? new BirdeyeSecurityProvider() : undefined,
  }, profile);

  if (!out) {
    console.log("  Could not build a feature vector. See above for why.\n");
    return;
  }
  const { signal: s, result } = out;

  console.log("  WHERE THE DATA CAME FROM");
  for (const p of result.provenance) console.log(`    · ${p}`);

  console.log(`\n  ${s.label}   score ${s.score}/100   confidence ${(s.confidence * 100).toFixed(0)}%`);
  if (s.noTradeReason) console.log(`  NO TRADE: ${s.noTradeReason}`);

  const scored = s.factors.filter((f) => f.weight !== 0);
  const dropped = s.factors.filter((f) => f.weight === 0);

  console.log(`\n  FACTORS SCORED (${scored.length})`);
  for (const f of scored.sort((a, b) => b.contribution - a.contribution)) {
    console.log(
      `    ${f.name.padEnd(24)} ${bar(f.normalized)} ${f.contribution >= 0 ? "+" : ""}${f.contribution.toFixed(1)}`,
    );
    console.log(`      ${f.explanation}`);
  }

  if (dropped.length) {
    console.log(`\n  FACTORS DROPPED (${dropped.length}) — not scored, not counted as zero`);
    for (const f of dropped) console.log(`    ${f.name.padEnd(24)} ${f.explanation}`);
  }

  const f = result.features;
  console.log(`\n  VECTOR`);
  console.log(`    price      $${f.mint === mint ? result.snapshot.priceUsd.toExponential(4) : "?"}`);
  console.log(`    liquidity  $${Math.round(f.liquidityUsd).toLocaleString()}   exit depth ~$${Math.round(f.exitDepthUsd).toLocaleString()}`);
  console.log(`    momentum   1h ${f.momentum1h.toFixed(1)}%   24h ${f.momentum24h.toFixed(1)}%`);
  console.log(`    volume     ${f.volumeAccel.toFixed(2)}x trailing baseline`);
  console.log(`    top10      ${f.unmeasured?.includes("top10Pct") ? "UNKNOWN" : `${(f.top10Pct * 100).toFixed(1)}%`}`);
  console.log(`    age        ${f.ageHours < 48 ? `${f.ageHours.toFixed(0)}h` : `${(f.ageHours / 24).toFixed(0)}d`}   regime ${f.regime}`);
  console.log(`    unmeasured ${f.unmeasured?.length ?? 0} fields: ${(f.unmeasured ?? []).join(", ") || "none"}`);
  console.log("");
}

void main();
