"use client";

// The copy desk's own record: what the reader followed, at what price, and
// how it went — kept in this browser, sized by a plan the reader set.
//
// Nova executes nothing. "I followed" means the reader bought in their own
// wallet and told the app the price; from then on the desk marks the
// position to the last trade the radar sees on that mint, shouts when the
// signal wallet exits, and keeps the closed trades as the reader's copy
// record — median return, hit rate, SOL made or lost at the plan's size.
// Nothing here is inferred from the chain about the reader: the entry and
// the exit are what they typed, which is the only honest source there is
// without a wallet connection.

import { pinMint } from "./hunter";

const FOLLOWS_KEY = "whalenova_follows_v1";
const PLAN_KEY = "whalenova_copyplan_v1";
/** Follows kept, open or closed; the oldest closed one goes first. */
export const FOLLOW_CAP = 200;

export interface Follow {
  id: string;
  /** the radar signal this follows, when it was one — null for a manual entry */
  signalKey: string | null;
  mint: string;
  name: string | null;
  wallet: string | null;
  /** SOL per token, what the reader paid */
  entryPriceSol: number;
  entryAt: number;
  sizeSol: number;
  exitPriceSol: number | null;
  closedAt: number | null;
}

export interface CopyPlan {
  /** the SOL the reader is willing to trade with, in total */
  bankrollSol: number;
  /** per-signal size as a percentage of the bankroll */
  riskPct: number;
  /**
   * What a round trip costs the reader, in percent: the curve's fee both
   * ways plus priority fees and slippage. Every return the desk shows is
   * netted against it, because a +2% grade is a loss after the curve has
   * taken its cut twice.
   */
  costPct: number;
}

export const DEFAULT_PLAN: CopyPlan = { bankrollSol: 5, riskPct: 2, costPct: 2.5 };
export const RISK_CHOICES = [0.5, 1, 2, 5] as const;
export const COST_CHOICES = [1, 2.5, 5] as const;

// ------------------------------------------------------------- the stores

const listeners = new Set<() => void>();
let followsRaw: string | null = null;
let followsParsed: Follow[] = [];
let planRaw: string | null = null;
let planParsed: CopyPlan = DEFAULT_PLAN;
const SERVER_FOLLOWS: Follow[] = [];

function readRaw(key: string): string {
  try {
    return typeof localStorage === "undefined" ? "" : (localStorage.getItem(key) ?? "");
  } catch {
    return "";
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window or quota: the desk still works for this page load */
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function parseFollows(raw: string): Follow[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((o): Follow | null => {
        const f = (o ?? {}) as Record<string, unknown>;
        if (typeof f.id !== "string" || typeof f.mint !== "string") return null;
        return {
          id: f.id,
          signalKey: strOrNull(f.signalKey),
          mint: f.mint,
          name: strOrNull(f.name),
          wallet: strOrNull(f.wallet),
          entryPriceSol: num(f.entryPriceSol),
          entryAt: num(f.entryAt),
          sizeSol: num(f.sizeSol),
          exitPriceSol: numOrNull(f.exitPriceSol),
          closedAt: numOrNull(f.closedAt),
        };
      })
      .filter((f): f is Follow => f !== null && f.entryPriceSol > 0);
  } catch {
    return [];
  }
}

function parsePlan(raw: string): CopyPlan {
  if (!raw) return DEFAULT_PLAN;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const bankrollSol = num(p.bankrollSol);
    const riskPct = num(p.riskPct);
    const costPct = num(p.costPct);
    return {
      bankrollSol: bankrollSol > 0 ? bankrollSol : DEFAULT_PLAN.bankrollSol,
      riskPct: (RISK_CHOICES as readonly number[]).includes(riskPct) ? riskPct : DEFAULT_PLAN.riskPct,
      costPct: (COST_CHOICES as readonly number[]).includes(costPct) ? costPct : DEFAULT_PLAN.costPct,
    };
  } catch {
    return DEFAULT_PLAN;
  }
}

/** The parsed follows, cached against the raw string so the snapshot is stable. */
export function followsSnapshot(): Follow[] {
  const raw = readRaw(FOLLOWS_KEY);
  if (raw !== followsRaw) {
    followsRaw = raw;
    followsParsed = parseFollows(raw);
  }
  return followsParsed;
}
export const followsServerSnapshot = (): Follow[] => SERVER_FOLLOWS;

export function copyPlanSnapshot(): CopyPlan {
  const raw = readRaw(PLAN_KEY);
  if (raw !== planRaw) {
    planRaw = raw;
    planParsed = parsePlan(raw);
  }
  return planParsed;
}
export const copyPlanServerSnapshot = (): CopyPlan => DEFAULT_PLAN;

export function subscribeFollows(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function notify(): void {
  for (const l of listeners) l();
}

function saveFollows(next: Follow[]): void {
  // Keep the cap by dropping the oldest CLOSED follow first; open positions
  // are never silently forgotten.
  let rows = next;
  while (rows.length > FOLLOW_CAP) {
    const idx = rows.findIndex((f) => f.closedAt !== null);
    if (idx < 0) break;
    rows = rows.filter((_, i) => i !== idx);
  }
  writeRaw(FOLLOWS_KEY, JSON.stringify(rows));
  followsRaw = null; // force a re-parse on the next read
  notify();
}

// -------------------------------------------------------------- the plan

export function setCopyPlan(plan: CopyPlan): void {
  writeRaw(PLAN_KEY, JSON.stringify(plan));
  planRaw = null;
  notify();
}

/** What one signal is worth at the plan: bankroll × risk. */
export function suggestedSizeSol(plan: CopyPlan): number {
  return Math.round(plan.bankrollSol * (plan.riskPct / 100) * 1000) / 1000;
}

// ------------------------------------------------------------- the desk

export function addFollow(input: {
  signalKey: string | null;
  mint: string;
  name: string | null;
  wallet: string | null;
  entryPriceSol: number;
  sizeSol: number;
}): Follow | null {
  if (!(input.entryPriceSol > 0) || !input.mint) return null;
  const f: Follow = {
    id: `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    signalKey: input.signalKey,
    mint: input.mint,
    name: input.name,
    wallet: input.wallet,
    entryPriceSol: input.entryPriceSol,
    entryAt: Date.now(),
    sizeSol: Math.max(0, input.sizeSol),
    exitPriceSol: null,
    closedAt: null,
  };
  saveFollows([f, ...followsSnapshot()]);
  pinMint(f.mint, true);
  return f;
}

export function closeFollow(id: string, exitPriceSol: number): void {
  if (!(exitPriceSol > 0)) return;
  const rows = followsSnapshot();
  const target = rows.find((f) => f.id === id);
  if (!target || target.closedAt !== null) return;
  saveFollows(rows.map((f) => (f.id === id ? { ...f, exitPriceSol, closedAt: Date.now() } : f)));
  unpinIfIdle(target.mint);
}

export function removeFollow(id: string): void {
  const rows = followsSnapshot();
  const target = rows.find((f) => f.id === id);
  if (!target) return;
  saveFollows(rows.filter((f) => f.id !== id));
  unpinIfIdle(target.mint);
}

function unpinIfIdle(mint: string): void {
  if (!followsSnapshot().some((f) => f.mint === mint && f.closedAt === null)) pinMint(mint, false);
}

/** Mints with an open follow — what the hunter keeps pricing. */
export function openFollowMints(): string[] {
  return [...new Set(followsSnapshot().filter((f) => f.closedAt === null).map((f) => f.mint))];
}

/** A follow's gross return against a mark, as a fraction; null without a mark. */
export function followReturn(f: Follow, markPriceSol: number | null): number | null {
  const mark = f.closedAt !== null ? f.exitPriceSol : markPriceSol;
  return mark && mark > 0 ? mark / f.entryPriceSol - 1 : null;
}

/** The same return net of the plan's round-trip cost. */
export function followReturnNet(f: Follow, markPriceSol: number | null, plan: CopyPlan): number | null {
  const gross = followReturn(f, markPriceSol);
  return gross === null ? null : gross - plan.costPct / 100;
}

/**
 * The reader's own copy record over CLOSED follows: how many, the median
 * return, the share at or above +10%, and SOL made or lost at the sizes
 * they recorded. Honest by construction — every number is one the reader
 * typed, which is why an empty record says nothing at all.
 */
export function copyRecord(rows: Follow[], costPct = 0): { closed: number; median: number | null; hitRate: number | null; pnlSol: number } {
  const closed = rows.filter((f) => f.closedAt !== null && f.exitPriceSol !== null);
  if (closed.length === 0) return { closed: 0, median: null, hitRate: null, pnlSol: 0 };
  // Net of the round-trip cost: what was banked, not what the chart did.
  const rets = closed.map((f) => f.exitPriceSol! / f.entryPriceSol - 1 - costPct / 100).sort((a, b) => a - b);
  const mid = rets.length >> 1;
  const median = rets.length % 2 ? rets[mid] : (rets[mid - 1] + rets[mid]) / 2;
  const hits = rets.filter((r) => r >= 0.1).length;
  const pnlSol = closed.reduce((acc, f) => acc + f.sizeSol * (f.exitPriceSol! / f.entryPriceSol - 1 - costPct / 100), 0);
  return { closed: closed.length, median, hitRate: hits / rets.length, pnlSol };
}

// Open follows keep their mints priced from the moment the app loads, not
// from the moment the desk is looked at.
if (typeof window !== "undefined") {
  for (const m of openFollowMints()) pinMint(m, true);
}
