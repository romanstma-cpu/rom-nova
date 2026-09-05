// The graded model: a claim about which signals pay, held to the same
// standard as the signals themselves.
//
// A logistic regression over the radar's own graded record — what was
// known about a signal AT THE MOMENT it fired, against whether its
// five-minute grade cleared the bar a bonding-curve round trip needs. It
// is trained on the older part of the record and judged ONLY on the newer
// part it never saw, in time order, because signals cluster in hours and
// a random split would let the model peek. Its verdict is one of three
// words: insufficient (not enough graded signals for the test fold to mean
// anything), no edge (the top quarter of its picks did not beat following
// every signal by more than noise), edge (it did, by two standard errors,
// with a better Brier score too). Nothing here is a trade instruction; a
// probability on a signal is the model's guess, and the forward record —
// the guesses it made on signals graded AFTER it was trained — is the only
// part that can earn it trust.
//
// Pure, shared: the worker trains it on its database and the app trains it
// on this browser's journal, and both print the same card.

export const MODEL_VERSION = "lr-1";
/** A five-minute grade at or above this is a hit — the bar a curve round trip needs. */
export const HIT_RET = 0.1;
/** Usable graded signals before a card can say anything. */
export const MIN_USABLE = 200;
/** Signals the test fold needs. */
export const MIN_TEST = 60;
export const TEST_FRACTION = 0.3;
/** The model's picks: the top share of a fold by probability. */
export const TOP_SHARE = 0.25;
/** Picks the verdict needs before it will call an edge. */
export const MIN_TOP = 15;
/** The probability at or above which the model "acts", for the forward record. */
export const ACT_P = 0.5;

export const FEATURES = ["score", "settled", "size", "price", "ageKnown", "age", "hourSin", "hourCos", "walletHour", "mintDay", "sinceLast"];
/** What each weight means, for the card. */
export const FEATURE_NOTES = {
  score: "the wallet's score walking into the buy",
  settled: "settled sells behind that score (log)",
  size: "SOL the wallet put in (log)",
  price: "price at the fill (log10) — how far up the curve",
  ageKnown: "whether the launch was seen",
  age: "minutes since launch (log)",
  hourSin: "time of day, UTC",
  hourCos: "time of day, UTC",
  walletHour: "this wallet's signals in the previous hour",
  mintDay: "earlier signals on this mint in the previous day",
  sinceLast: "minutes since this wallet's previous signal (log)",
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CAP_MIN = 1_440;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/**
 * The feature vector for one signal, given its context from EARLIER
 * signals only. NaN marks a value nobody saw; standardization turns it
 * into the train mean.
 * @param {any} row @param {{ walletHour: number, mintDay: number, sinceLastMin: number }} ctx
 * @returns {number[]}
 */
export function featuresOf(row, ctx) {
  const ts = Date.parse(row.timestamp);
  const d = Number.isFinite(ts) ? new Date(ts) : new Date(0);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const price = num(row.price_at_signal);
  const age = num(row.launch_age_ms);
  return [
    num(row.wallet_score) ?? 0,
    Math.log1p(Math.max(0, num(row.settled_sells) ?? 0)),
    Math.log1p(Math.max(0, num(row.buy_amount_sol) ?? 0)),
    price !== null && price > 0 ? Math.log10(price) : NaN,
    age === null ? 0 : 1,
    age === null ? NaN : Math.log1p(Math.min(CAP_MIN, Math.max(0, age / 60_000))),
    Math.sin((2 * Math.PI * hour) / 24),
    Math.cos((2 * Math.PI * hour) / 24),
    ctx.walletHour,
    ctx.mintDay,
    Math.log1p(Math.min(CAP_MIN, Math.max(0, ctx.sinceLastMin))),
  ];
}

/**
 * Walk signals in time order, handing each the context of the ones before
 * it: how busy its wallet was in the last hour, how crowded its mint was
 * in the last day, how long since the wallet's previous signal.
 * @param {any[]} rows
 * @returns {{ row: any, ts: number, ctx: { walletHour: number, mintDay: number, sinceLastMin: number } }[]}
 */
export function contextsOf(rows) {
  const sorted = rows
    .map((r) => ({ r, ts: Date.parse(r.timestamp) }))
    .filter((x) => Number.isFinite(x.ts))
    .sort((a, b) => a.ts - b.ts);
  /** @type {Map<string, number[]>} */
  const walletTimes = new Map();
  /** @type {Map<string, number[]>} */
  const mintTimes = new Map();
  const out = [];
  for (const { r, ts } of sorted) {
    const wt = walletTimes.get(r.wallet_address) ?? [];
    const mt = mintTimes.get(r.token_address) ?? [];
    const last = wt.length ? wt[wt.length - 1] : null;
    out.push({
      row: r,
      ts,
      ctx: {
        walletHour: wt.filter((t) => ts - t <= HOUR_MS).length,
        mintDay: mt.filter((t) => ts - t <= DAY_MS).length,
        sinceLastMin: last === null ? CAP_MIN : (ts - last) / 60_000,
      },
    });
    wt.push(ts);
    walletTimes.set(r.wallet_address, wt.slice(-100));
    mt.push(ts);
    mintTimes.set(r.token_address, mt.slice(-100));
  }
  return out;
}

/**
 * Rows → samples the model may learn from: graded at five minutes, not
 * marked to a stale price, with a fill price. Everything else is counted
 * out by reason.
 * @param {any[]} rows @param {{ hitRet?: number }} [opts]
 */
export function samplesOf(rows, opts = {}) {
  const hitRet = opts.hitRet ?? HIT_RET;
  const excluded = { ungraded: 0, stale: 0, unpriced: 0 };
  const samples = [];
  for (const { row, ts, ctx } of contextsOf(rows)) {
    const ret = num(row.ret_5m);
    if (ret === null) {
      excluded.ungraded++;
      continue;
    }
    if (row.graded_stale === true) {
      excluded.stale++;
      continue;
    }
    const x = featuresOf(row, ctx);
    if (Number.isNaN(x[3])) {
      excluded.unpriced++;
      continue;
    }
    samples.push({
      key: row.signal_key ?? `${row.wallet_address}:${row.token_address}:${row.timestamp}`,
      ts,
      x,
      y: ret >= hitRet ? 1 : 0,
      ret,
      p: num(row.model_p),
    });
  }
  return { samples, excluded };
}

/** Per-feature mean and sd over the values that exist; sd 0 becomes 1. */
export function fitNorm(X) {
  const d = X[0]?.length ?? FEATURES.length;
  const mean = new Array(d).fill(0);
  const sd = new Array(d).fill(1);
  for (let j = 0; j < d; j++) {
    const vals = X.map((x) => x[j]).filter((v) => Number.isFinite(v));
    if (vals.length === 0) continue;
    const m = vals.reduce((s, v) => s + v, 0) / vals.length;
    const v = vals.reduce((s, x) => s + (x - m) * (x - m), 0) / vals.length;
    mean[j] = m;
    sd[j] = v > 0 ? Math.sqrt(v) : 1;
  }
  return { mean, sd };
}

/** @param {number[]} x @param {{ mean: number[], sd: number[] }} norm */
export function standardize(x, norm) {
  return x.map((v, j) => (Number.isFinite(v) ? (v - norm.mean[j]) / norm.sd[j] : 0));
}

/**
 * Logistic regression by full-batch gradient descent with a little L2 —
 * small enough to run in a browser tab over a few hundred rows in a blink,
 * deterministic, no library.
 * @param {number[][]} X standardized @param {number[]} y 0/1
 */
export function fitLogistic(X, y, opts = {}) {
  const iterations = opts.iterations ?? 400;
  const lr = opts.lr ?? 0.1;
  const l2 = opts.l2 ?? 0.01;
  const n = X.length;
  const d = X[0].length;
  const w = new Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iterations; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const err = sigmoid(z) - y[i];
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= (lr * gb) / n;
  }
  return { w, b };
}

/** @param {{ w: number[], b: number }} fit @param {number[]} xs standardized */
const scoreOf = (fit, xs) => sigmoid(fit.b + fit.w.reduce((s, wj, j) => s + wj * xs[j], 0));

/**
 * One fold, judged: the base rate, the model's top quarter against it with
 * a binomial standard error, what it would have acted on, and Brier.
 * @param {{ x: number[], y: number }[]} samples
 */
export function evaluate(samples, norm, fit, opts = {}) {
  const topShare = opts.topShare ?? TOP_SHARE;
  const actP = opts.actP ?? ACT_P;
  const ps = samples.map((s) => scoreOf(fit, standardize(s.x, norm)));
  return judge(samples.map((s, i) => ({ y: s.y, p: ps[i] })), { topShare, actP });
}

/**
 * The judgement over (p, y) pairs — shared by the test fold and the
 * forward record, so both read the same way.
 * @param {{ p: number, y: number }[]} pairs
 */
export function judge(pairs, opts = {}) {
  const topShare = opts.topShare ?? TOP_SHARE;
  const actP = opts.actP ?? ACT_P;
  const n = pairs.length;
  if (n === 0) return null;
  const hits = pairs.reduce((s, q) => s + q.y, 0);
  const baseline = hits / n;
  const brier = pairs.reduce((s, q) => s + (q.p - q.y) ** 2, 0) / n;
  const brierBaseline = pairs.reduce((s, q) => s + (baseline - q.y) ** 2, 0) / n;
  const order = pairs.map((q, i) => i).sort((a, b) => pairs[b].p - pairs[a].p);
  const k = Math.max(1, Math.floor(n * topShare));
  const topHits = order.slice(0, k).reduce((s, i) => s + pairs[i].y, 0);
  const acted = pairs.filter((q) => q.p >= actP);
  const actedHits = acted.reduce((s, q) => s + q.y, 0);
  const round = (v) => Number(v.toFixed(4));
  return {
    n,
    hits,
    baseline: round(baseline),
    brier: round(brier),
    brier_baseline: round(brierBaseline),
    top: {
      k,
      hits: topHits,
      precision: round(topHits / k),
      se: round(Math.sqrt((baseline * (1 - baseline)) / k)),
      lift: baseline > 0 ? round(topHits / k / baseline) : null,
    },
    acted: { n: acted.length, hits: actedHits, precision: acted.length ? round(actedHits / acted.length) : null },
  };
}

/** @param {ReturnType<typeof judge>} test */
export function verdictOf(test) {
  if (!test || test.top.k < MIN_TOP) return "insufficient";
  const gain = test.top.precision - test.baseline;
  if (gain > 2 * test.top.se && test.top.lift !== null && test.top.lift >= 1.2 && test.brier < test.brier_baseline) return "edge";
  return "no edge";
}

const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * Train and judge, in time order. Returns the card — everything a reader
 * or another process needs to understand, reproduce and apply it.
 * @param {any[]} rows signal rows, graded or not
 * @param {{ now?: number, hitRet?: number, minUsable?: number, minTest?: number }} [opts]
 */
export function trainModel(rows, opts = {}) {
  const now = opts.now ?? Date.now();
  const hitRet = opts.hitRet ?? HIT_RET;
  const minUsable = opts.minUsable ?? MIN_USABLE;
  const minTest = opts.minTest ?? MIN_TEST;
  const { samples, excluded } = samplesOf(rows, { hitRet });
  const base = {
    version: MODEL_VERSION,
    trained_at: new Date(now).toISOString(),
    hit_ret: hitRet,
    rows: rows.length,
    usable: samples.length,
    excluded,
    features: FEATURES,
  };
  const insufficient = (note) => ({ ...base, verdict: "insufficient", note, split: null, train: null, test: null, weights: null, intercept: null, norm: null });
  if (samples.length < minUsable) {
    return insufficient(`${samples.length} usable graded signal${samples.length === 1 ? "" : "s"}; the model needs ${minUsable} before a held-out fold means anything`);
  }
  const cut = Math.floor(samples.length * (1 - TEST_FRACTION));
  const train = samples.slice(0, cut);
  const test = samples.slice(cut);
  if (test.length < minTest) return insufficient(`${test.length} signals in the held-out fold; it needs ${minTest}`);

  const norm = fitNorm(train.map((s) => s.x));
  const fit = fitLogistic(
    train.map((s) => standardize(s.x, norm)),
    train.map((s) => s.y),
  );
  const trainEval = evaluate(train, norm, fit);
  const testEval = evaluate(test, norm, fit);
  const verdict = verdictOf(testEval);
  const weights = Object.fromEntries(FEATURES.map((f, j) => [f, Number(fit.w[j].toFixed(4))]));
  const t = testEval;
  const note =
    verdict === "edge"
      ? `on the ${t.n} newest signals it never saw, its top quarter (${t.top.k}) hit ${pct(t.top.precision)} against ${pct(t.baseline)} for every signal, ±${pct(t.top.se)} — an edge on paper; the forward record decides`
      : `on the ${t.n} newest signals it never saw, its top quarter (${t.top.k}) hit ${pct(t.top.precision)} against ${pct(t.baseline)} for every signal, ±${pct(t.top.se)} — not beyond noise`;
  return {
    ...base,
    verdict,
    note,
    split: {
      train_n: train.length,
      train_from: new Date(train[0].ts).toISOString(),
      train_to: new Date(train[train.length - 1].ts).toISOString(),
      test_n: test.length,
      test_from: new Date(test[0].ts).toISOString(),
      test_to: new Date(test[test.length - 1].ts).toISOString(),
    },
    train: trainEval,
    test: testEval,
    weights,
    intercept: Number(fit.b.toFixed(4)),
    norm: { mean: norm.mean.map((v) => Number(v.toFixed(6))), sd: norm.sd.map((v) => Number(v.toFixed(6))) },
  };
}

/**
 * The model's probability for one signal, from a card. Null without a
 * fitted card — an "insufficient" card predicts nothing.
 * @param {any} card @param {any} row @param {{ walletHour: number, mintDay: number, sinceLastMin: number }} ctx
 * @returns {number | null}
 */
export function predictP(card, row, ctx) {
  if (!card || !card.weights || !card.norm || typeof card.intercept !== "number") return null;
  const xs = standardize(featuresOf(row, ctx), card.norm);
  let z = card.intercept;
  FEATURES.forEach((f, j) => {
    z += (card.weights[f] ?? 0) * xs[j];
  });
  return Number(sigmoid(z).toFixed(3));
}

/**
 * The forward record: signals that carried a probability WHEN THEY FIRED
 * and have since been graded. Judged the same way as the test fold. This
 * is the only claim about the model that was not made with hindsight.
 * @param {any[]} rows @param {{ hitRet?: number }} [opts]
 */
export function forwardRecord(rows, opts = {}) {
  const hitRet = opts.hitRet ?? HIT_RET;
  const pairs = [];
  let first = null;
  let last = null;
  for (const r of rows) {
    const p = num(r.model_p);
    const ret = num(r.ret_5m);
    if (p === null || ret === null || r.graded_stale === true) continue;
    const ts = Date.parse(r.timestamp);
    if (Number.isFinite(ts)) {
      first = first === null ? ts : Math.min(first, ts);
      last = last === null ? ts : Math.max(last, ts);
    }
    pairs.push({ p, y: ret >= hitRet ? 1 : 0 });
  }
  const judged = judge(pairs);
  if (!judged) return null;
  return { ...judged, verdict: verdictOf(judged), from: first === null ? null : new Date(first).toISOString(), to: last === null ? null : new Date(last).toISOString() };
}
