// The live signals feed: what the scored trending list becomes between passes.
//
// WHY THIS EXISTS
//
// `scoreRows` in api/source.ts has built a real signal for every live token row
// for a while — score, label, kind, confidence, the abstention reason, the
// list of factors that stood down — and then kept only the six fields a table
// cell needs. Nothing materialised those as `Signal`s. `/signals` and
// `/signal?id=` read the simulator alone, and the whole-build review found
// thirty synthetic position-sizing cards under no marker (H5) beside a
// dashboard KPI counting simulated signals while the Momentum Leaders table
// two panels over showed live scores of 80 and 65 that the counter could not
// see (H7).
//
// WHAT THIS IS
//
// A registry, in process, of every pass the live list has produced this
// session — the same idiom the launch feed uses for `firstSeenAt`. Each pass
// hands over the MEASURED feature vectors; everything a reader asks for is
// derived from them here:
//
//   - a `Signal` per mint per strategy profile, scored from the vector by the
//     one scorer the simulator uses, so a live and a simulated signal are the
//     same kind of object;
//   - an id that is STABLE across passes for as long as the mint carries the
//     same label, in the simulator's own scheme (`sig-<mint8>-<bucket>-<profile>`)
//     so `/signal?id=` resolves either kind;
//   - a lifecycle: created on the first pass this mint carried this label,
//     confirmed / strengthened / weakened on later passes, expired when the
//     label changes or the mint leaves the list;
//   - the `signal_created` event on the live bus when a mint FIRST reaches a
//     positive band, deduplicated per mint per 45 minutes the way the
//     simulator's sweep already is;
//   - the achieved refresh cadence, measured from the passes that landed,
//     rather than the 30-second cache constant the code was written to.
//
// WHAT THIS NEVER DOES
//
// Read simulated data. Every number here descends from a vector a live
// provider built; the simulator is not imported. And it never invents a
// history: a mint scored on demand that this session has not seen on the
// list gets a lifecycle that says so, not a fabricated createdAt.

import { emitLiveEvent, type LiveEvent } from "./bus";
import { scoreFeatures, POSITIVE_LABELS } from "../engine/signals";
import { flowWindowLabel } from "../engine/flow-window";
import { noteOutcome } from "../providers/health-log";
import type { LiveFeatureResult } from "../engine/live-features";
import type {
  FeatureVector,
  Signal,
  SignalLabel,
  SignalLifecycleEvent,
  StrategyProfileId,
} from "../types";

const HOUR = 3_600_000;

/**
 * How long after a `signal_created` event the same mint stays quiet.
 *
 * The simulator's sweep uses the same window. A mint that drops out of the
 * positive band and re-enters it eleven minutes later is one story, not two
 * toasts.
 */
export const SIGNAL_EVENT_DEDUPE_MS = 45 * 60_000;

/** Score movement that counts as strengthened / weakened, as in `signalsAt`. */
const LIFECYCLE_STEP = 6;

/** How many pass timestamps to keep for the cadence figure. */
const PASS_HISTORY = 64;
/** Retired tracks kept so a stale `/signal?id=` link can still show its story. */
const RETIRED_CAP = 200;
/** Lifecycle entries per track. A day of 30-second passes would be 2,880. */
const LIFECYCLE_CAP = 40;
const RECENT_EVENTS_CAP = 50;

/** One mint, as one pass measured it. Nothing here is recomputed later. */
interface Observed {
  mint: string;
  symbol: string;
  name: string;
  hue: number;
  features: FeatureVector;
  /** The per-mint provenance lines `liveFeatures` wrote, verbatim. */
  provenance: string[];
  authorityChecked: boolean;
  authoritySource?: string;
  riskSource?: string;
  flowSource?: string;
}

interface Pass {
  /** ms epoch on this machine's clock, read ONCE for the whole pass. */
  at: number;
  /** The token provider that supplied the list. */
  source: string;
  seq: number;
  byMint: Map<string, Observed>;
}

/** The life of one (mint, profile) under one label. */
interface Track {
  id: string;
  mint: string;
  profile: StrategyProfileId;
  label: SignalLabel;
  createdAt: number;
  updatedAt: number;
  score: number;
  passes: number;
  lifecycle: SignalLifecycleEvent[];
  expiredAt?: number;
}

export interface LiveSignalRow extends Signal {
  symbol: string;
  name: string;
  hue: number;
  /** Where every number in this signal came from, per mint. */
  provenance: string[];
  /** The token provider behind the list. */
  source: string;
  live: {
    /** Passes this mint has carried this label. */
    passes: number;
    firstSeenAt: number;
    lastSeenAt: number;
  };
}

export interface PassStats {
  /** Signals that began on this pass — a new mint, or a mint under a new label. */
  fresh: number;
  /** Signals that carried the same label from the previous pass. */
  updated: number;
  /** Signals that ended on this pass — label changed, or the mint left the list. */
  expired: number;
}

export interface Cadence {
  /** Median gap between consecutive passes, or null with fewer than two passes. */
  medianMs: number | null;
  /** How many gaps the median is over. One gap is a reading, not a cadence. */
  samples: number;
  lastGapMs: number | null;
}

export interface LiveSignalFeed {
  signals: LiveSignalRow[];
  pass: { at: number; source: string; seq: number; mints: number };
  stats: PassStats;
  cadence: Cadence;
}

// ------------------------------------------------------------------ state

let current: Pass | null = null;
let seq = 0;
const passTimes: number[] = [];
/** Every mint this session has scored, by the 8-character prefix an id carries. */
const mintByPrefix = new Map<string, string>();
/** Active tracks, keyed `${profile}:${mint}`. */
const tracks = new Map<string, Track>();
/** Retired tracks by id, so a link outlives the signal it names. */
const retired = new Map<string, Track>();
/** Which pass each profile has been advanced to. */
const advancedTo = new Map<StrategyProfileId, number>();
const passStats = new Map<StrategyProfileId, PassStats>();
/** When each mint last produced a `signal_created`, for the dedupe. */
const emittedAt = new Map<string, number>();
const recentEvents: LiveEvent[] = [];

const key = (profile: StrategyProfileId, mint: string) => `${profile}:${mint}`;

/**
 * The id scheme, shared with the simulator so one regex parses both:
 * `sig-<mint8>-<number>-<profile>`.
 *
 * The number is the CREATION second, not the simulator's two-hour bucket.
 * Stability across passes comes from stamping it once, at creation — the
 * simulator buckets on the scoring moment because it has no memory between
 * calls; this does. And it is a second rather than a bucket because two
 * signals for one mint can begin inside one two-hour window — POSITIVE, then
 * EXTREME RISK thirty seconds later when an authority read changes — and the
 * first draft of this gave them the same id. The test caught it before a
 * reader did.
 */
function idFor(mint: string, createdAt: number, profile: StrategyProfileId): string {
  return `sig-${mint.slice(0, 8)}-${Math.floor(createdAt / 1000)}-${profile}`;
}

// ---------------------------------------------------------------- observe

/**
 * Record one pass of the live list.
 *
 * Called by `scoreRows` with every vector it built, under ONE timestamp — the
 * same rule the track ledger enforces, for the same reason: twelve rows read
 * off one cached list are one observation of the market, and per-row clocks
 * would scatter one pass into twelve.
 *
 * Returns the stable id for each mint under the balanced profile, so the
 * list row can link to the signal the feed will actually serve.
 */
export function observeLivePass(input: { at: number; source: string; rows: LiveFeatureResult[] }): Map<string, string> {
  const byMint = new Map<string, Observed>();
  for (const r of input.rows) {
    const mint = r.features.mint;
    byMint.set(mint, {
      mint,
      symbol: r.info.symbol,
      name: r.info.name,
      hue: r.info.hue,
      features: r.features,
      provenance: r.provenance,
      authorityChecked: r.authorityChecked,
      authoritySource: r.authoritySource,
      riskSource: r.risk?.source,
      flowSource: r.flow?.source,
    });
    mintByPrefix.set(mint.slice(0, 8), mint);
  }
  current = { at: input.at, source: input.source, seq: ++seq, byMint };
  passTimes.push(input.at);
  if (passTimes.length > PASS_HISTORY) passTimes.splice(0, passTimes.length - PASS_HISTORY);

  // Balanced always: it is the profile the list rows carry and the one the
  // event stream watches. Every other profile advances only once somebody has
  // asked for it — a lifecycle nobody requested would be a history nobody
  // observed.
  const profiles = new Set<StrategyProfileId>(["balanced", ...advancedTo.keys()]);
  for (const p of profiles) advance(p);

  noteOutcome("signals", true);

  const ids = new Map<string, string>();
  for (const mint of byMint.keys()) {
    const t = tracks.get(key("balanced", mint));
    if (t) ids.set(mint, t.id);
  }
  return ids;
}

/** Move one profile's tracks forward to the current pass. Idempotent per pass. */
function advance(profile: StrategyProfileId): void {
  if (!current) return;
  if (advancedTo.get(profile) === current.seq) return;
  advancedTo.set(profile, current.seq);

  const stats: PassStats = { fresh: 0, updated: 0, expired: 0 };
  const now = current.at;

  for (const obs of current.byMint.values()) {
    const sig = scoreFeatures(obs.features, obs.mint, now, profile);
    const k = key(profile, obs.mint);
    const existing = tracks.get(k);

    if (existing && existing.label === sig.label) {
      // The same story, one pass longer. Movement notes mirror `signalsAt`.
      const delta = sig.score - existing.score;
      if (delta >= LIFECYCLE_STEP) {
        pushLifecycle(existing, { state: "strengthened", ts: now, note: `${existing.score} → ${sig.score}` });
      } else if (delta <= -LIFECYCLE_STEP) {
        pushLifecycle(existing, { state: "weakened", ts: now, note: `${existing.score} → ${sig.score}` });
      } else if (sig.score >= 64) {
        pushLifecycle(existing, { state: "confirmed", ts: now });
      }
      existing.updatedAt = now;
      existing.score = sig.score;
      existing.passes++;
      stats.updated++;
      continue;
    }

    let previous: SignalLabel | undefined;
    if (existing) {
      // A new label is a new signal. The old one ends here, and its record
      // says why, so a link to its id still tells the truth.
      retire(existing, now, `label ${existing.label} → ${sig.label}`);
      previous = existing.label;
      stats.expired++;
    }
    const track: Track = {
      id: idFor(obs.mint, now, profile),
      mint: obs.mint,
      profile,
      label: sig.label,
      createdAt: now,
      updatedAt: now,
      score: sig.score,
      passes: 1,
      lifecycle: [
        {
          state: "created",
          ts: now,
          note: previous
            ? `moved ${previous} → ${sig.label}`
            : "first seen on the live list at this label — it may have reached it before the list did",
        },
      ],
    };
    tracks.set(k, track);
    stats.fresh++;

    if (profile === "balanced") maybeEmit(obs, sig, previous, now);
  }

  // Mints that were on the previous pass and are not on this one. Leaving a
  // trending list is not a verdict on the token; it is the end of this
  // session's ability to watch it, and the record says exactly that.
  for (const [k, t] of tracks) {
    if (t.profile !== profile) continue;
    if (current.byMint.has(t.mint)) continue;
    retire(t, now, "left the trending list — no longer observed, not invalidated");
    tracks.delete(k);
    stats.expired++;
  }

  passStats.set(profile, stats);
}

function pushLifecycle(t: Track, e: SignalLifecycleEvent): void {
  t.lifecycle.push(e);
  // Keep the first entry — the creation — and the newest of the rest.
  if (t.lifecycle.length > LIFECYCLE_CAP) t.lifecycle.splice(1, t.lifecycle.length - LIFECYCLE_CAP);
}

function retire(t: Track, at: number, why: string): void {
  t.expiredAt = at;
  pushLifecycle(t, { state: "expired", ts: at, note: why });
  tracks.delete(key(t.profile, t.mint));
  retired.set(t.id, t);
  if (retired.size > RETIRED_CAP) retired.delete(retired.keys().next().value!);
}

/**
 * The `signal_created` event, when a mint first reaches a positive band.
 *
 * Only the positive labels: NO TRADE, WATCH and the risk labels are findings
 * too, but they are not the thing a toast interrupts a reader for. The detail
 * carries the measured basis — which sources answered, how many inputs stood
 * down, the flow window — because an event with a confidence figure and no
 * account of what the confidence is over is the shape of every fake alert
 * this app was built to stop copying.
 */
function maybeEmit(obs: Observed, sig: Signal, previous: SignalLabel | undefined, now: number): void {
  if (!POSITIVE_LABELS.includes(sig.label)) return;
  const last = emittedAt.get(obs.mint);
  if (last !== undefined && now - last < SIGNAL_EVENT_DEDUPE_MS) return;
  emittedAt.set(obs.mint, now);

  const unmeasured = obs.features.unmeasured ?? [];
  const sources = [obs.authoritySource, obs.riskSource, obs.flowSource].filter(Boolean);
  const basis =
    `measured on ${[current?.source ?? "the live list", ...sources].join(" + ")}` +
    (unmeasured.length ? `; ${unmeasured.length} input${unmeasured.length === 1 ? "" : "s"} unmeasured (${unmeasured.join(", ")})` : "; every input measured") +
    `; flow window ${flowWindowLabel(obs.features.flowWindowMs)}`;
  const how = previous ? `moved ${previous} → ${sig.label}` : `first seen on the list at ${sig.label}`;

  const ev = emitLiveEvent({
    id: `live-sig-${obs.mint.slice(0, 8)}-${now.toString(36)}`,
    kind: "signal_created",
    ts: now,
    mint: obs.mint,
    symbol: obs.symbol,
    headline: `LIVE SIGNAL ${sig.score}/100 · ${sig.label}`,
    detail: `${obs.symbol}: ${sig.kind.replace(/_/g, " ")} — ${sig.why[0] ?? ""} · ${how} · ${basis}`,
    confidence: sig.confidence,
    real: true,
    source: "signals-live",
  });
  recentEvents.unshift(ev);
  if (recentEvents.length > RECENT_EVENTS_CAP) recentEvents.length = RECENT_EVENTS_CAP;
}

// ------------------------------------------------------------------ reads

/**
 * The feed for one profile, or null before the first pass has landed.
 *
 * Re-scores from the stored vectors rather than caching signals: twelve
 * `scoreFeatures` calls are microseconds, and a cache would be a second copy
 * of the truth to keep in step.
 */
export function liveSignalsFor(profile: StrategyProfileId = "balanced"): LiveSignalFeed | null {
  if (!current) return null;
  advance(profile);
  const signals: LiveSignalRow[] = [];
  for (const obs of current.byMint.values()) {
    const track = tracks.get(key(profile, obs.mint));
    if (!track) continue;
    const sig = scoreFeatures(obs.features, obs.mint, current.at, profile);
    signals.push({
      ...sig,
      id: track.id,
      createdAt: track.createdAt,
      updatedAt: track.updatedAt,
      lifecycle: track.lifecycle,
      symbol: obs.symbol,
      name: obs.name,
      hue: obs.hue,
      provenance: obs.provenance,
      source: current.source,
      live: { passes: track.passes, firstSeenAt: track.createdAt, lastSeenAt: track.updatedAt },
    });
  }
  signals.sort((a, b) => b.score - a.score);
  return {
    signals,
    pass: { at: current.at, source: current.source, seq: current.seq, mints: current.byMint.size },
    stats: passStats.get(profile) ?? { fresh: 0, updated: 0, expired: 0 },
    cadence: achievedCadence(),
  };
}

/** The full mint behind an id's 8-character prefix, if this session scored it. */
export function resolveLiveMint(prefix: string): string | null {
  return mintByPrefix.get(prefix) ?? null;
}

/**
 * The lifecycle record for a (mint, profile), active or retired.
 *
 * `id` lets a stale link find the exact retired track it named rather than
 * whatever the mint is doing now.
 */
export function liveTrackFor(
  mint: string,
  profile: StrategyProfileId,
  id?: string,
): { id: string; label: SignalLabel; createdAt: number; updatedAt: number; passes: number; lifecycle: SignalLifecycleEvent[]; expiredAt?: number } | null {
  const active = tracks.get(key(profile, mint));
  if (active && (!id || active.id === id)) return active;
  const old = id ? retired.get(id) : undefined;
  return old ?? active ?? null;
}

export function lastLivePass(): { at: number; source: string; seq: number; mints: number } | null {
  return current ? { at: current.at, source: current.source, seq: current.seq, mints: current.byMint.size } : null;
}

/**
 * The refresh cadence actually achieved, from the passes that landed.
 *
 * Not the cache constant. The list cache is 30 seconds and the scanner polls
 * every 8, so the code "means" a pass every half minute — but a hidden tab
 * polls nothing, a rate-limited vendor serves the stale list, and a pass that
 * takes five seconds to assemble lands late. The median gap is the figure a
 * reader can hold the page to.
 */
export function achievedCadence(): Cadence {
  if (passTimes.length < 2) return { medianMs: null, samples: 0, lastGapMs: null };
  const gaps: number[] = [];
  for (let i = 1; i < passTimes.length; i++) gaps.push(passTimes[i] - passTimes[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { medianMs: median, samples: gaps.length, lastGapMs: gaps[gaps.length - 1] };
}

/** The `signal_created` events this session emitted, newest first. */
export function recentLiveSignalEvents(limit = 20): LiveEvent[] {
  return recentEvents.slice(0, limit);
}

/** Test seam. Nothing in the app clears this; a reload does. */
export function __resetLiveSignals(): void {
  current = null;
  seq = 0;
  passTimes.length = 0;
  mintByPrefix.clear();
  tracks.clear();
  retired.clear();
  advancedTo.clear();
  passStats.clear();
  emittedAt.clear();
  recentEvents.length = 0;
}
