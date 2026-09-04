// The radar's own track record: what its signals were worth, graded by the
// stream that produced them, summed up the way a reader would ask.
//
// Same rules as the scanner's track record next door. Nothing is fitted
// after the fact: every grade was written by a later trade or quote against
// the signal's own fill price. Medians, not means, because one 40× candle
// should not make a wallet look like it pays. Hit rates are stated at the
// threshold that clears a bonding-curve round trip in fees, and every
// figure is shown gross AND net of a round-trip cost the reader sets,
// because a +8% grade is a loss once the curve has taken its cut twice.

import { HORIZON_FIELD, type RadarHorizon, type RadarSignalRow } from "./journal";
import { medianOf } from "./engine/util.js";

/** A grade at or above this counts as a hit — the same bar the engine uses. */
export const HIT_RET = 0.1;
/** Graded signals a wallet needs before its row is shown. */
export const MIN_WALLET_GRADES = 2;
/** The wallet sold inside this after its signal: a copier was most likely still buying. */
export const EXIT_BEFORE_YOU_MS = 60_000;

export interface HorizonStat {
  horizon: RadarHorizon;
  label: string;
  graded: number;
  medianGross: number | null;
  medianNet: number | null;
  hitRate: number | null;
  stale: number;
}

export interface WalletStat {
  wallet: string;
  signals: number;
  graded: number;
  median5m: number | null;
  hit5m: number | null;
  exits: number;
  medianExitAfterMs: number | null;
}

export interface DayStat {
  day: string;
  signals: number;
  graded: number;
  median5m: number | null;
  hit5m: number | null;
}

export interface SignalRecord {
  signals: number;
  wallets: number;
  costPct: number;
  horizons: HorizonStat[];
  peakMedian: number | null;
  exits: { n: number; medianRet: number | null; medianAfterMs: number | null; beforeYou: number };
  byWallet: WalletStat[];
  byDay: DayStat[];
  staleAny: number;
  lookupAny: number;
}

const LABEL: Record<RadarHorizon, string> = { m1: "+1m", m5: "+5m", m15: "+15m", h1: "+1h" };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Net of a round-trip cost: what a copier banked, not what the chart did. */
export const netOf = (gross: number, costPct: number): number => gross - costPct / 100;

function horizonStat(rows: RadarSignalRow[], h: RadarHorizon, costPct: number): HorizonStat {
  const field = HORIZON_FIELD[h];
  const grades = rows.map((r) => r[field]).filter(isNum);
  const stale = rows.filter((r) => isNum(r[field]) && r.graded_stale).length;
  const median = medianOf(grades);
  return {
    horizon: h,
    label: LABEL[h],
    graded: grades.length,
    medianGross: median,
    medianNet: median === null ? null : netOf(median, costPct),
    hitRate: grades.length ? grades.filter((g) => g >= HIT_RET).length / grades.length : null,
    stale,
  };
}

/**
 * The record over a set of journaled signals. Pure; the pages hand it the
 * journal (this browser) or a worker's ring.
 */
export function signalRecord(rows: readonly RadarSignalRow[], costPct: number): SignalRecord {
  const all = [...rows];
  const horizons = (["m1", "m5", "m15", "h1"] as RadarHorizon[]).map((h) => horizonStat(all, h, costPct));
  const peaks = all.map((r) => r.peak_ret_1h).filter(isNum);
  const exited = all.filter((r) => isNum(r.whale_exit_ret));
  const exitAfter = exited.map((r) => r.whale_exit_after_ms).filter(isNum);

  const byWalletMap = new Map<string, RadarSignalRow[]>();
  for (const r of all) {
    const list = byWalletMap.get(r.wallet_address) ?? [];
    list.push(r);
    byWalletMap.set(r.wallet_address, list);
  }
  const byWallet: WalletStat[] = [...byWalletMap.entries()]
    .map(([wallet, list]) => {
      const g5 = list.map((r) => r.ret_5m).filter(isNum);
      const ex = list.filter((r) => isNum(r.whale_exit_ret));
      return {
        wallet,
        signals: list.length,
        graded: g5.length,
        median5m: medianOf(g5),
        hit5m: g5.length ? g5.filter((g) => g >= HIT_RET).length / g5.length : null,
        exits: ex.length,
        medianExitAfterMs: medianOf(ex.map((r) => r.whale_exit_after_ms).filter(isNum)),
      };
    })
    .filter((w) => w.graded >= MIN_WALLET_GRADES)
    .sort((a, b) => (b.median5m ?? -Infinity) - (a.median5m ?? -Infinity) || b.graded - a.graded);

  const byDayMap = new Map<string, RadarSignalRow[]>();
  for (const r of all) {
    const day = r.timestamp.slice(0, 10);
    const list = byDayMap.get(day) ?? [];
    list.push(r);
    byDayMap.set(day, list);
  }
  const byDay: DayStat[] = [...byDayMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 14)
    .map(([day, list]) => {
      const g5 = list.map((r) => r.ret_5m).filter(isNum);
      return {
        day,
        signals: list.length,
        graded: g5.length,
        median5m: medianOf(g5),
        hit5m: g5.length ? g5.filter((g) => g >= HIT_RET).length / g5.length : null,
      };
    });

  return {
    signals: all.length,
    wallets: byWalletMap.size,
    costPct,
    horizons,
    peakMedian: medianOf(peaks),
    exits: {
      n: exited.length,
      medianRet: medianOf(exited.map((r) => r.whale_exit_ret).filter(isNum)),
      medianAfterMs: medianOf(exitAfter),
      beforeYou: exitAfter.filter((ms) => ms <= EXIT_BEFORE_YOU_MS).length,
    },
    byWallet,
    byDay,
    staleAny: all.filter((r) => r.graded_stale).length,
    lookupAny: all.filter((r) => r.graded_lookup).length,
  };
}
