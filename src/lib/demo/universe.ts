// Deterministic synthetic Solana universe for demo mode.
//
// Design rule: nothing here is random per-request. One seed produces the
// entire world — tokens, price paths, wallets, trades — so the app looks
// identical across restarts and screenshots, and tests can assert on it.
//
// The generator writes history up to a genesis timestamp (now, rounded to
// the hour). The live simulator (simulator.ts) takes over from there.

import { Rng, fakeAddress, fakeSignature } from "./rng";
import type {
  Candle,
  Dex,
  Narrative,
  TokenInfo,
  WalletCluster,
  WalletInfo,
  WalletLabel,
  WalletTrade,
} from "../types";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const HISTORY_DAYS = 30;

export type Archetype =
  | "moonshot"
  | "rug"
  | "grinder"
  | "chopper"
  | "fader"
  | "sleeper"
  | "fresh";

export interface TokenSeries {
  info: TokenInfo;
  archetype: Archetype;
  supply: number;
  candles: Candle[]; // hourly, from creation (capped to HISTORY_DAYS)
  liquidityUsd: number[]; // aligned with candles
  holders: number[]; // aligned with candles
  /** simulator state: current drift/vol regime to continue the path */
  drift: number;
  vol: number;
}

export interface DemoUniverse {
  seed: number;
  genesis: number; // ms epoch the history ends at (hour-aligned)
  tokens: Map<string, TokenSeries>;
  wallets: Map<string, WalletInfo>;
  trades: WalletTrade[]; // all wallet trades, ascending ts
  clusters: WalletCluster[];
  solPath: Candle[]; // hourly SOL/USD
}

// ---------------------------------------------------------------- naming

const WORDS: Record<Narrative, string[]> = {
  AI: ["NEURON", "AGENT", "SYNTH", "ORACLE", "TENSOR", "GOLEM", "CORTEX", "VECTOR"],
  Dogs: ["WOOF", "BONKER", "SHIBE", "PUPPER", "HOUND", "BISCUIT", "ZOOMIE", "SNOOT"],
  Cats: ["MEOW", "WHISKER", "POUNCE", "CATNIP", "FELIX", "PURR", "TABBY", "TOEBEAN"],
  Politics: ["BALLOT", "FILIBUS", "CAUCUS", "VETO", "GAVEL", "MANDATE", "LOBBY", "RECOUNT"],
  Gaming: ["RESPAWN", "CRIT", "LOOT", "SPEEDRUN", "NOSCOPE", "GLITCH", "PIXEL", "MANA"],
  Celebrity: ["ENCORE", "PAPARAZZO", "REDCARPET", "STAN", "TABLOID", "CAMEO", "VIRAL", "GOSSIP"],
  Internet: ["RATIO", "COPIUM", "TOUCHGRASS", "LURKER", "BASED", "GIGACHAD", "SLOP", "DOOMSCROLL"],
  DeFi: ["YIELD", "VAULT", "REBASE", "FLASH", "STAKE", "CURVE", "DELTA", "BASIS"],
  Community: ["FRENS", "VIBE", "COZY", "CAMPFIRE", "HARBOR", "COMMONS", "CHORUS", "BEACON"],
};

const SUFFIX = ["", " PROTOCOL", " COIN", " ON SOL", " CLUB", " SZN", " CAPITAL", " WORLD"];

// ---------------------------------------------------------------- phases

interface Phase {
  hours: number;
  drift: number; // hourly log drift
  vol: number; // hourly log stdev
  volumeBoost: number;
}

// Phases carry a TARGET TOTAL log move; hourly drift is target/hours. This
// keeps lifetime price multiples bounded per archetype regardless of token
// age — the first generator compounded fixed hourly drift over the whole
// age and produced e^30 moonshots (measured, not guessed).
function phasesFor(arch: Archetype, ageHours: number, rng: Rng): Phase[] {
  const p = (hours: number, targetLog: number, vol: number, volumeBoost = 1): Phase => {
    const h = Math.max(1, Math.round(hours));
    return { hours: h, drift: targetLog / h, vol, volumeBoost };
  };
  switch (arch) {
    case "moonshot": {
      const totalLog = rng.range(2.3, 4.4); // 10x–80x lifetime
      return [
        p(ageHours * 0.08, totalLog * 0.45, 0.06, 3), // launch pump
        p(ageHours * 0.12, -totalLog * 0.15, 0.04, 1.4), // pullback
        p(ageHours * 0.45, totalLog * 0.35, 0.028, 1), // grind
        p(ageHours * 0.2, totalLog * 0.45, 0.04, 2), // second leg
        p(ageHours * 0.15, -totalLog * 0.1, 0.032, 1.2), // distribution
      ];
    }
    case "rug": {
      const pumpH = rng.range(8, 30);
      return [
        p(pumpH, rng.range(1.2, 2.2), 0.07, 4), // 3x–9x pump
        p(2, -rng.range(1.8, 2.6), 0.2, 6), // the rug: −84% to −93%
        p(Math.max(2, ageHours - pumpH - 2), -rng.range(0.5, 1.2), 0.018, 0.05),
      ];
    }
    case "grinder":
      return [
        p(ageHours * 0.3, rng.range(0.2, 0.5), 0.025, 1),
        p(ageHours * 0.3, rng.range(0.0, 0.3), 0.02, 0.9),
        p(ageHours * 0.4, rng.range(0.3, 0.7), 0.025, 1.1),
      ];
    case "chopper":
      return [
        p(ageHours * 0.5, rng.range(-0.15, 0.25), 0.035, 1),
        p(ageHours * 0.5, rng.range(-0.25, 0.15), 0.035, 1),
      ];
    case "fader":
      return [
        p(ageHours * 0.15, rng.range(0.9, 1.6), 0.05, 2.5), // 2.5x–5x pump
        p(ageHours * 0.85, -rng.range(1.3, 2.2), 0.025, 0.6), // long bleed
      ];
    case "sleeper":
      return [
        p(ageHours * 0.85, rng.range(-0.1, 0.15), 0.015, 0.4), // long flat
        p(ageHours * 0.15, rng.range(0.9, 1.7), 0.045, 3.5), // recent ignition
      ];
    case "fresh": {
      return [
        p(ageHours * 0.4, rng.range(1.2, 2.2), 0.07, 3.5),
        p(ageHours * 0.35, -rng.range(0.3, 0.7), 0.045, 1.5),
        p(ageHours * 0.25, rng.range(0.5, 1.1), 0.055, 2.8),
      ];
    }
  }
}

// ---------------------------------------------------------------- tokens

const ARCH_PLAN: [Archetype, number][] = [
  ["moonshot", 14],
  ["rug", 12],
  ["grinder", 20],
  ["chopper", 24],
  ["fader", 18],
  ["sleeper", 10],
  ["fresh", 12],
];

function genToken(rng: Rng, arch: Archetype, genesis: number, idx: number): TokenSeries {
  const narrative = rng.pick(Object.keys(WORDS) as Narrative[]);
  const word = rng.pick(WORDS[narrative]);
  const name = `${word[0]}${word.slice(1).toLowerCase()}${rng.pick(SUFFIX)}`;
  const symbol = (word.slice(0, rng.int(3, 6)) + (rng.chance(0.15) ? String(rng.int(2, 9)) : "")).toUpperCase();

  const ageHours =
    arch === "fresh"
      ? rng.range(6, 46)
      : arch === "sleeper"
        ? rng.range(24 * 12, 24 * 60)
        : rng.range(48, 24 * 90);
  const createdAt = genesis - Math.round(ageHours) * HOUR;
  const supply = rng.pick([1e9, 1e9, 1e9, 6.9e8, 4.2e8, 1e8]);
  // starting market cap at creation
  const mcap0 = arch === "fresh" ? rng.heavyTail(90_000, 0.6) : rng.heavyTail(450_000, 0.9);
  const price0 = mcap0 / supply;

  // size phases on the FULL age so the skip loop consumes early phases and
  // the visible 30-day window lands mid-story, not compounding past it
  const script = phasesFor(arch, ageHours, rng);
  const histStart = Math.max(createdAt, genesis - HISTORY_DAYS * DAY);
  const bars = Math.max(3, Math.round((genesis - histStart) / HOUR));

  // walk the log-price path
  const candles: Candle[] = [];
  const liquidityUsd: number[] = [];
  const holders: number[] = [];
  let logP = Math.log(price0);
  // if history is truncated, fast-forward through skipped phases
  const skippedHours = Math.max(0, Math.round((histStart - createdAt) / HOUR));
  let phaseIdx = 0;
  let phaseLeft = script[0].hours;
  for (let i = 0; i < skippedHours; i++) {
    const ph = script[Math.min(phaseIdx, script.length - 1)];
    logP += ph.drift + rng.gaussian(0, ph.vol);
    if (--phaseLeft <= 0 && phaseIdx < script.length - 1) {
      phaseIdx++;
      phaseLeft = script[phaseIdx].hours;
    }
  }

  const liqFactor = rng.range(0.05, 0.22); // liquidity as share of mcap (sqrt-damped)
  let holderCount = arch === "fresh" ? rng.int(40, 300) : rng.int(150, 900);
  // when the rug predates the visible window, the whole window is
  // post-collapse — clamp to 0 so the liquidity discount still applies
  const rugHour = arch === "rug" ? Math.max(0, script[0].hours + 2 - skippedHours) : -1;

  for (let i = 0; i < bars; i++) {
    const ph = script[Math.min(phaseIdx, script.length - 1)];
    const t = histStart + i * HOUR;
    const o = Math.exp(logP);
    const ret = ph.drift + rng.gaussian(0, ph.vol);
    logP += ret;
    const c = Math.exp(logP);
    const wick = Math.abs(rng.gaussian(0, ph.vol * 0.7));
    const h = Math.max(o, c) * (1 + wick);
    const l = Math.min(o, c) / (1 + Math.abs(rng.gaussian(0, ph.vol * 0.5)));
    const mcap = c * supply;
    const baseVol = Math.sqrt(mcap) * rng.range(18, 55);
    const v = baseVol * ph.volumeBoost * (0.4 + Math.abs(ret) * 22) * rng.range(0.5, 1.6);
    candles.push({ t, o, h, l, c, v });

    // liquidity: proportional to mcap with a mild sub-linear damp for the
    // biggest tokens; collapses at rug hour ($1M mcap ≈ $50–200K pooled)
    let liq = Math.pow(mcap, 0.93) * liqFactor * 2.4;
    if (rugHour >= 0 && i >= rugHour) liq *= 0.06;
    liquidityUsd.push(liq * rng.range(0.92, 1.08));

    // holders: grow with volume, churn in drawdowns
    const growth = Math.max(0, v / 90_000) * rng.range(0.4, 1.4);
    const churn = ret < -0.05 ? holderCount * 0.006 : 0;
    holderCount = Math.max(25, holderCount + growth - churn);
    holders.push(Math.round(holderCount));

    if (--phaseLeft <= 0 && phaseIdx < script.length - 1) {
      phaseIdx++;
      phaseLeft = script[phaseIdx].hours;
    }
  }

  const lastPhase = script[Math.min(phaseIdx, script.length - 1)];
  const mintRng = rng.fork(`mint${idx}`);
  const rugged = arch === "rug";
  const info: TokenInfo = {
    mint: fakeAddress(mintRng),
    name,
    symbol,
    createdAt,
    decimals: 9,
    narrative,
    verified: !rugged && rng.chance(arch === "fresh" ? 0.25 : 0.6),
    mintAuthorityRevoked: rugged ? rng.chance(0.3) : rng.chance(0.85),
    freezeAuthorityRevoked: rugged ? rng.chance(0.4) : rng.chance(0.9),
    permanentDelegate: rng.chance(0.04),
    devWallet: fakeAddress(mintRng),
    hue: rng.int(0, 359),
  };

  return {
    info,
    archetype: arch,
    supply,
    candles,
    liquidityUsd,
    holders,
    drift: lastPhase.drift,
    vol: lastPhase.vol,
  };
}

// ---------------------------------------------------------------- wallets

interface WalletArch {
  label: WalletLabel;
  count: number;
  skill: [number, number]; // timing skill range 0..1
  sizeUsd: [number, number];
  entity?: string[];
}

const WALLET_PLAN: WalletArch[] = [
  { label: "smart_trader", count: 9, skill: [0.72, 0.95], sizeUsd: [4_000, 60_000] },
  { label: "whale", count: 8, skill: [0.35, 0.7], sizeUsd: [40_000, 420_000] },
  { label: "fund", count: 2, skill: [0.6, 0.8], sizeUsd: [60_000, 500_000], entity: ["Meridian Desk", "Tidewater Capital"] },
  { label: "sniper", count: 3, skill: [0.55, 0.75], sizeUsd: [3_000, 25_000] },
  { label: "insider", count: 2, skill: [0.65, 0.85], sizeUsd: [8_000, 90_000] },
  { label: "bundler", count: 2, skill: [0.3, 0.5], sizeUsd: [5_000, 40_000] },
  { label: "bot", count: 2, skill: [0.25, 0.45], sizeUsd: [1_000, 12_000] },
  { label: "dev", count: 2, skill: [0.4, 0.6], sizeUsd: [5_000, 60_000] },
];

export interface WalletSeed {
  info: WalletInfo;
  skill: number;
  sizeUsd: [number, number];
}

function genWallets(rng: Rng, genesis: number): WalletSeed[] {
  const out: WalletSeed[] = [];
  for (const plan of WALLET_PLAN) {
    for (let i = 0; i < plan.count; i++) {
      const wRng = rng.fork(`${plan.label}${i}`);
      const skill = wRng.range(plan.skill[0], plan.skill[1]);
      const address = fakeAddress(wRng);
      const info: WalletInfo = {
        address,
        labels: [plan.label, ...(wRng.chance(0.3) && plan.label !== "whale" ? (["whale"] as WalletLabel[]) : [])],
        knownEntity: plan.entity?.[i],
        fundingSource: wRng.chance(0.6) ? rng.pick(["CEX hot wallet", "bridge", "older wallet", "unknown"]) : undefined,
        firstSeen: genesis - wRng.int(40, 400) * DAY,
        lastActive: genesis - wRng.int(0, 48) * HOUR,
        solBalance: wRng.heavyTail(plan.label === "whale" ? 4200 : 260, 0.9),
        // placeholder; replaced after trades are generated and measured
        smartMoney: {
          total: 0,
          performance: 0,
          timing: 0,
          consistency: 0,
          riskManagement: 0,
          diversification: 0,
          dataConfidence: 0,
        },
        behavior: {
          earlyBird: plan.label === "sniper" ? wRng.range(0.8, 0.98) : wRng.range(0.1, 0.7),
          momentumBias: wRng.range(0.2, 0.9),
          typicalEntryMcap: wRng.heavyTail(800_000, 1.2),
          typicalExitMultiple: wRng.range(1.4, 6),
          medianHoldHours: wRng.heavyTail(30, 0.9),
          preferredDex: wRng.pick(["Raydium", "Orca", "Meteora", "Pump.fun", "Phoenix"] as Dex[]),
          smallCapPreference: wRng.range(0.2, 0.95),
        },
      };
      out.push({ info, skill, sizeUsd: plan.sizeUsd });
    }
  }
  return out;
}

// ---------------------------------------------------------------- trades

/** Pick an index in [from, to) with `skill`. Skilled wallets buy cheap and
 * sell dear; unskilled wallets do what unskilled money actually does — buy
 * the top of the candidate set (chasing) and sell its bottom (capitulating).
 * Each pick flips a skill-weighted coin, so skill maps monotonically onto
 * measured PnL instead of everyone profiting from universe drift. */
function skilledPick(
  rng: Rng,
  candles: Candle[],
  from: number,
  to: number,
  skill: number,
  side: "entry" | "exit",
): number {
  const span = to - from;
  if (span <= 1) return from;
  const candidates = 2 + Math.round(skill * skill * 12);
  const smart = rng.chance(0.15 + skill * 0.8);
  // smart entries hunt lows / smart exits hunt highs; dumb picks invert
  const wantLow = side === "entry" ? smart : !smart;
  let best = from + rng.int(0, span - 1);
  let bestVal = -Infinity;
  for (let k = 0; k < candidates; k++) {
    const i = from + rng.int(0, span - 1);
    const val = wantLow ? -Math.log(candles[i].c) : Math.log(candles[i].c);
    if (val > bestVal) {
      bestVal = val;
      best = i;
    }
  }
  return best;
}

const DEXES: Dex[] = ["Raydium", "Orca", "Meteora", "Pump.fun", "Phoenix"];

function genTrades(
  rng: Rng,
  wallets: WalletSeed[],
  tokens: TokenSeries[],
  genesis: number,
): { trades: WalletTrade[]; clusters: WalletCluster[] } {
  const trades: WalletTrade[] = [];
  let tradeSeq = 0;

  // pre-defined clusters: members share picks with small entry lags
  const smart = wallets.filter((w) => w.info.labels.includes("smart_trader"));
  const clusterDefs = [
    { name: "Sable Group", members: smart.slice(0, 3).map((w) => w.info.address), lagSec: 420 },
    { name: "Northlight Cohort", members: smart.slice(3, 6).map((w) => w.info.address), lagSec: 660 },
    {
      name: "Harbor Cluster",
      members: [...wallets.filter((w) => w.info.labels.includes("fund")).map((w) => w.info.address), smart[6]?.info.address].filter(Boolean) as string[],
      lagSec: 900,
    },
  ];
  const clusterOf = new Map<string, { def: (typeof clusterDefs)[0]; slot: number }>();
  clusterDefs.forEach((def) => def.members.forEach((m, i) => clusterOf.set(m, { def, slot: i })));
  const clusterPicks = new Map<string, Map<string, number>>(); // clusterName -> mint -> leader entry idx
  const clusterTokens = new Map<string, Set<string>>();

  const emit = (
    wRng: Rng,
    w: WalletSeed,
    tok: TokenSeries,
    idx: number,
    side: "buy" | "sell",
    usd: number,
    classification: WalletTrade["classification"],
    lagMs = 0,
  ) => {
    const candle = tok.candles[idx];
    if (!candle) return;
    const price = candle.c * wRng.range(0.98, 1.02);
    trades.push({
      id: `t${++tradeSeq}`,
      signature: fakeSignature(wRng),
      wallet: w.info.address,
      mint: tok.info.mint,
      ts: candle.t + Math.round(wRng.range(0, HOUR * 0.9)) + lagMs,
      side,
      amountUsd: usd,
      amountTokens: usd / price,
      priceUsd: price,
      dex: wRng.chance(0.6) ? w.info.behavior.preferredDex : wRng.pick(DEXES),
      classification,
      confidence: wRng.range(0.62, 0.98),
    });
  };

  for (const w of wallets) {
    const wRng = rng.fork(`trades:${w.info.address}`);
    const nTokens = wRng.int(10, 24);
    // wallets prefer non-rug tokens in proportion to skill (skilled wallets dodge rugs)
    const pool = tokens.filter((t) => t.candles.length > 8);
    const cluster = clusterOf.get(w.info.address);

    for (let n = 0; n < nTokens; n++) {
      let tok = wRng.pick(pool);
      // skilled wallets dodge structurally doomed tokens (two re-rolls)
      for (let d = 0; d < 2; d++) {
        if ((tok.archetype === "rug" || tok.archetype === "fader") && wRng.chance(w.skill)) tok = wRng.pick(pool);
      }
      const candles = tok.candles;

      // cluster coordination: follow the leader's pick/entry on shared tokens
      let entryIdx: number;
      let lagMs = 0;
      const picks = cluster ? clusterPicks.get(cluster.def.name) : undefined;
      if (cluster && picks?.has(tok.info.mint)) {
        entryIdx = picks.get(tok.info.mint)!;
        lagMs = cluster.slot * cluster.def.lagSec * 1000 * wRng.range(0.7, 1.3);
        clusterTokens.get(cluster.def.name)!.add(tok.info.mint);
      } else {
        const earliest = w.info.behavior.earlyBird > 0.75 ? 0 : Math.floor(candles.length * 0.05);
        entryIdx = skilledPick(wRng, candles, earliest, candles.length - 1, w.skill, "entry");
        if (cluster && wRng.chance(0.55)) {
          if (!clusterPicks.has(cluster.def.name)) {
            clusterPicks.set(cluster.def.name, new Map());
            clusterTokens.set(cluster.def.name, new Set());
          }
          clusterPicks.get(cluster.def.name)!.set(tok.info.mint, entryIdx);
          clusterTokens.get(cluster.def.name)!.add(tok.info.mint);
        }
      }

      // size is capped by the pool at entry — nobody buys half the supply
      const liqAtEntry = tok.liquidityUsd[Math.min(entryIdx, tok.liquidityUsd.length - 1)] ?? 50_000;
      const totalUsd = Math.min(wRng.range(w.sizeUsd[0], w.sizeUsd[1]), liqAtEntry * 0.25);
      const legs = wRng.int(1, 3);
      for (let leg = 0; leg < legs; leg++) {
        const li = Math.min(candles.length - 1, entryIdx + leg * wRng.int(1, 4));
        emit(wRng, w, tok, li, "buy", totalUsd / legs, leg === 0 ? "open" : "add", lagMs);
      }

      // exit: skilled wallets time it; some recent positions stay open
      const stillOpen = entryIdx > candles.length - 8 || wRng.chance(0.15);
      if (!stillOpen) {
        const exitIdx = skilledPick(
          wRng,
          candles,
          Math.min(candles.length - 1, entryIdx + 1),
          candles.length,
          w.skill,
          "exit", // best exit = the most expensive reachable point
        );
        const exitLegs = wRng.int(1, 2);
        // exit valued at exit-time price: sell tokens bought (approx by USD at entry scaled by price ratio)
        const entryPrice = candles[entryIdx].c;
        for (let leg = 0; leg < exitLegs; leg++) {
          const li = Math.min(candles.length - 1, exitIdx + leg * wRng.int(1, 3));
          const exitPrice = candles[li].c;
          const usdOut = ((totalUsd / entryPrice) * exitPrice) / exitLegs;
          emit(wRng, w, tok, li, "sell", usdOut, leg === exitLegs - 1 ? "exit" : "reduce", lagMs);
        }
      }
    }
  }

  trades.sort((a, b) => a.ts - b.ts);

  const clusters: WalletCluster[] = clusterDefs
    .filter((d) => (clusterTokens.get(d.name)?.size ?? 0) >= 2)
    .map((d, i) => {
      const shared = [...(clusterTokens.get(d.name) ?? [])];
      return {
        id: `cl${i + 1}`,
        name: d.name,
        members: d.members,
        sharedTokens: shared,
        entryLagSec: d.lagSec,
        cohesion: Math.min(0.95, 0.4 + shared.length * 0.08),
        detectedAt: genesis - rng.int(1, 72) * HOUR,
        evidence: [
          `${d.members.length} wallets entered ${shared.length} shared tokens within ${Math.round((d.lagSec * d.members.length) / 60)} minutes of each other`,
          "historical overlap across multiple profitable exits",
          "similar position sizing pattern",
        ],
      };
    });

  return { trades, clusters };
}

// ---------------------------------------------------------------- SOL path

// The simulated SOL path is anchored so its final price lands on a real
// reference (checked against CoinGecko / Crypto.com / InfStones,
// 2026-08-25: ~$97.7). Override with ROMNOVA_SOL_ANCHOR.
const DEFAULT_SOL_ANCHOR = 97.7;

function genSolPath(rng: Rng, genesis: number): Candle[] {
  const bars = HISTORY_DAYS * 24;
  const start = genesis - bars * HOUR;
  let logP = Math.log(150);
  const candles: Candle[] = [];
  for (let i = 0; i < bars; i++) {
    const o = Math.exp(logP);
    const ret = rng.gaussian(0.0002, 0.008);
    logP += ret;
    const c = Math.exp(logP);
    candles.push({
      t: start + i * HOUR,
      o,
      h: Math.max(o, c) * (1 + Math.abs(rng.gaussian(0, 0.004))),
      l: Math.min(o, c) / (1 + Math.abs(rng.gaussian(0, 0.004))),
      c,
      v: rng.heavyTail(9e8, 0.3),
    });
  }
  // scale the whole walk so the last close hits the anchor exactly
  const anchor = Number(process.env.ROMNOVA_SOL_ANCHOR) || DEFAULT_SOL_ANCHOR;
  const k = anchor / candles[candles.length - 1].c;
  for (const c of candles) {
    c.o *= k;
    c.h *= k;
    c.l *= k;
    c.c *= k;
  }
  return candles;
}

// ---------------------------------------------------------------- build

export function buildUniverse(seed = 77): DemoUniverse {
  const genesis = Math.floor(Date.now() / HOUR) * HOUR;
  const rng = new Rng(seed);

  const tokens: TokenSeries[] = [];
  let idx = 0;
  for (const [arch, count] of ARCH_PLAN) {
    for (let i = 0; i < count; i++) tokens.push(genToken(rng.fork(`tok:${arch}:${i}`), arch, genesis, idx++));
  }

  const walletSeeds = genWallets(rng.fork("wallets"), genesis);
  const { trades, clusters } = genTrades(rng.fork("trades"), walletSeeds, tokens, genesis);

  return {
    seed,
    genesis,
    tokens: new Map(tokens.map((t) => [t.info.mint, t])),
    wallets: new Map(walletSeeds.map((w) => [w.info.address, w.info])),
    trades,
    clusters,
    solPath: genSolPath(rng.fork("sol"), genesis),
  };
}
