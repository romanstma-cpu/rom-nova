"use client";

// The graded model, typed for the app: the engine's pure JS trains and
// judges; this file names its card so pages can render it, and reads the
// summary a worker sends in its status.

import { FEATURE_NOTES, FEATURES, HIT_RET, MIN_USABLE, trainModel } from "./engine/model.js";
import type { RadarSignalRow } from "./journal";

export { FEATURE_NOTES, FEATURES, HIT_RET, MIN_USABLE };

export type ModelVerdict = "insufficient" | "no edge" | "edge";

export interface FoldJudgement {
  n: number;
  hits: number;
  baseline: number;
  brier: number;
  brier_baseline: number;
  top: { k: number; hits: number; precision: number; se: number; lift: number | null };
  acted: { n: number; hits: number; precision: number | null };
}

export interface ModelCard {
  version: string;
  trained_at: string;
  hit_ret: number;
  rows: number;
  usable: number;
  excluded: { ungraded: number; stale: number; unpriced: number };
  features: string[];
  verdict: ModelVerdict;
  note: string;
  split: { train_n: number; train_from: string; train_to: string; test_n: number; test_from: string; test_to: string } | null;
  train: FoldJudgement | null;
  test: FoldJudgement | null;
  weights: Record<string, number> | null;
  intercept: number | null;
  norm: { mean: number[]; sd: number[] } | null;
}

/** Train over rows — this browser's journal, typically — and get the card. */
export function trainCard(rows: readonly RadarSignalRow[], now?: number): ModelCard {
  return trainModel(rows as unknown[], { now }) as ModelCard;
}

/** What a worker's status carries about its model. */
export interface ModelSummary {
  version: string;
  verdict: ModelVerdict | "untrained";
  usable: number;
  trained_at: string | null;
  note: string | null;
  test: { n: number; baseline: number; top_precision: number; top_k: number; se: number; lift: number | null } | null;
  forward: { n: number; baseline: number; acted: number; acted_precision: number | null; top_precision: number; verdict: ModelVerdict } | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
const verdictOf = (v: unknown): ModelVerdict | "untrained" => (v === "insufficient" || v === "no edge" || v === "edge" ? v : "untrained");

export function normModelSummary(raw: unknown): ModelSummary | null {
  const o = obj(raw);
  if (!o) return null;
  const t = obj(o.test);
  const f = obj(o.forward);
  return {
    version: typeof o.version === "string" ? o.version : "",
    verdict: verdictOf(o.verdict),
    usable: num(o.usable),
    trained_at: typeof o.trained_at === "string" ? o.trained_at : null,
    note: typeof o.note === "string" ? o.note : null,
    test: t ? { n: num(t.n), baseline: num(t.baseline), top_precision: num(t.top_precision), top_k: num(t.top_k), se: num(t.se), lift: numOrNull(t.lift) } : null,
    forward: f
      ? {
          n: num(f.n),
          baseline: num(f.baseline),
          acted: num(f.acted),
          acted_precision: numOrNull(f.acted_precision),
          top_precision: num(f.top_precision),
          verdict: verdictOf(f.verdict) === "untrained" ? "insufficient" : (verdictOf(f.verdict) as ModelVerdict),
        }
      : null,
  };
}
