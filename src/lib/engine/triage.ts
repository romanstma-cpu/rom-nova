// Triage for a token that is seconds old.
//
// WHY THIS IS NOT THE SIGNAL ENGINE
//
// `signals.ts` weighs momentum, volume acceleration, holder growth and wallet
// flow. Every one of those is a rate of change, and a token forty seconds old
// has no rates: one price print, three holders, a bonding curve that has not
// moved. Running the scorer over it produces a number built almost entirely
// from factors that stood down, and a reader would still see a number.
//
// So a launch is not scored. It is TRIAGED: a fixed list of yes/no questions,
// each answered from evidence or explicitly not answered, and a verdict that
// carries the count of what could not be checked. The whole value of a sniper
// feed is deciding in ten seconds whether to look closer, and "seven checks,
// five ran, two of those failed" is a decision. A 41/100 is not.
//
// THE ONE RULE THIS FILE EXISTS FOR
//
// There is no positive verdict. A brand-new mint has had no time to accumulate
// findings, so an empty risk list is silence, not a clean bill — measured
// directly: RugCheck answered a seven-second-old mint in 130ms with
// `risks: []` and `score_normalised: 1`, which read literally says "the safest
// token on Solana". The best any launch can earn here is `unverified`, and the
// UI never paints it green.
//
// WHAT IS DELIBERATELY GRADED n/a, AND WHY IT MATTERS MOST
//
// LP lock. It is the headline safety fact for an AMM pool and it is MEANINGLESS
// on a pre-graduation launchpad token, which is what most of this feed is.
// Measured across brand-new pump.fun mints, RugCheck returned `lpLockedPct:
// 100` for four of five regardless of the token — that 100 is the bonding
// curve, which nobody can withdraw from because it is not a pool. Meanwhile the
// same field on the deepest, most liquid tokens on Solana reads 0.04 (PUMP,
// $41.9M liquidity) and 0.01 (TRUMP, $51.0M). Rendered naively, this column
// would show a green 100% on unaudited seconds-old mints and a red 0% on the
// two largest markets in the ecosystem — precisely inverted. So a token still
// on its curve gets `n/a` and a sentence explaining that the rug at this stage
// is the deployer selling their allocation, not pulling a pool.

import type { LaunchCheck, LaunchObservation, LaunchTriage, LaunchVerdict } from "../types";
import type { TokenRisk } from "../providers/types";

/**
 * Creator-history thresholds, set from the measured composition of the feed
 * rather than from instinct.
 *
 * 47 distinct brand-new mints were sampled across three pages twenty seconds
 * apart. Every one carried a `devMints` count, and the distribution is not
 * what an outsider would guess:
 *
 *   1 mint          10 of 47   (21%)
 *   2-4              4 of 47    (9%)
 *   5-49             9 of 47   (19%)
 *   50+             24 of 47   (51%)
 *   1,000+          13 of 47   (28%)
 *   median 75 mints · p90 3,536 · max 155,516
 *
 * The MEDIAN new pump.fun token comes from a wallet on its 75th mint. So 50 is
 * not a red line — it is the middle of the population, and failing it would
 * mark half the feed as AVOID and teach a reader to ignore the verdict inside
 * an hour. A wallet at a thousand mints is a different animal: that is a
 * quarter of the stream, produced by a machine, and one of them was on its
 * 155,516th token.
 */
export const INDUSTRIAL_DEPLOYER_MINTS = 1_000;
/** The median deployer. Worth naming, not worth condemning on its own. */
export const SERIAL_DEPLOYER_MINTS = 50;
/** Enough prior mints to be worth mentioning at all. */
export const REPEAT_DEPLOYER_MINTS = 5;
/**
 * Below this share of mints reaching a real pool, a high mint count is a spam
 * pipeline rather than a prolific creator. Measured examples: 159 of 3,911
 * (4.1%) and 68 of 5,623 (1.2%).
 */
export const DEAD_MINT_RATE = 0.05;

/** Deployer allocation at or above this is treated as a loaded gun. */
export const DEV_HOLD_FAIL = 0.2;
export const DEV_HOLD_WARN = 0.05;

/** Top-ten share thresholds, applied only where the number means a cap table. */
export const TOP10_FAIL = 0.8;
export const TOP10_WARN = 0.5;

/**
 * True while the token is still on a launchpad bonding curve.
 *
 * The distinction the whole file turns on. A curve is not a pool: there are no
 * LP tokens to lock or burn, the "top holders" are the curve itself, and the
 * only party who can take money off the table is the deployer selling into it.
 */
export function onBondingCurve(l: LaunchObservation): boolean {
  return Boolean(l.launchpad) && l.graduatedAt === undefined;
}

function check(
  key: string,
  name: string,
  state: LaunchCheck["state"],
  detail: string,
  opts: { assumed?: boolean; basis?: LaunchCheck["basis"] } = {},
): LaunchCheck {
  const out: LaunchCheck = { key, name, state, detail };
  if (opts.assumed) out.assumed = true;
  if (opts.basis) out.basis = opts.basis;
  return out;
}

/**
 * A pass that rests on somebody not finding anything.
 *
 * Kept as its own helper so adding a check forces the author to decide which
 * kind of pass it is. A vendor reporting no rug history for a wallet it has
 * never seen is indistinguishable, in its output, from one clearing a wallet it
 * knows — and on a token ninety seconds old the first is far more likely.
 */
const absencePass = (key: string, name: string, detail: string) =>
  check(key, name, "pass", detail, { basis: "absence" });
const readingPass = (key: string, name: string, detail: string) =>
  check(key, name, "pass", detail, { basis: "reading" });

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Mint and freeze authority, graded fail-safe.
 *
 * House rule: absent authority data is graded as NOT revoked, never as revoked.
 * That produces a `fail`, which is the correct thing to act on and the wrong
 * thing to describe as a measurement — so `assumed` marks the difference. A
 * reader who sees "mint authority LIVE" and one who sees "assumed live, the
 * source published nothing" are looking at two different situations, and a
 * launch feed that flattens them will cry wolf on every unindexed mint.
 */
function authorityChecks(l: LaunchObservation): LaunchCheck[] {
  if (!l.authorityKnown) {
    return [
      check(
        "mint_authority",
        "Mint authority",
        "fail",
        "The source published no audit for this mint. Graded as NOT revoked, because an unexamined token must never read as renounced — but nobody has actually looked.",
        { assumed: true },
      ),
      check(
        "freeze_authority",
        "Freeze authority",
        "fail",
        "The source published no audit for this mint. Graded as NOT revoked. Absence of a finding is not a finding of absence.",
        { assumed: true },
      ),
    ];
  }
  // The only two checks on a fresh launchpad mint that are hard chain readings
  // rather than an opinion or an absence.
  return [
    check(
      "mint_authority",
      "Mint authority",
      l.mintAuthorityRevoked ? "pass" : "fail",
      l.mintAuthorityRevoked
        ? "Revoked — the supply cannot be increased."
        : "LIVE — whoever holds that key can mint more supply out from under you at any time.",
      { basis: "reading" },
    ),
    check(
      "freeze_authority",
      "Freeze authority",
      l.freezeAuthorityRevoked ? "pass" : "fail",
      l.freezeAuthorityRevoked
        ? "Revoked — balances cannot be frozen."
        : "LIVE — whoever holds that key can freeze your balance in place, leaving you holding a token you cannot sell.",
      { basis: "reading" },
    ),
  ];
}

/**
 * The creator's history, which is the most useful fact on the row.
 *
 * A first mint is graded `pass` and says so carefully: there is no history to
 * hold against this wallet, which is not the same as a good one. Every serial
 * deployer's first token also looked like this.
 */
function creatorCheck(l: LaunchObservation): LaunchCheck {
  if (l.devMints === undefined) {
    return check("creator_history", "Creator history", "unchecked", "The source did not report how many mints this deployer has issued.");
  }
  const n = l.devMints.toLocaleString();
  const rate = l.devMigrations !== undefined && l.devMints > 0 ? l.devMigrations / l.devMints : undefined;
  const reached =
    l.devMigrations === undefined
      ? ""
      : ` ${l.devMigrations.toLocaleString()} of them reached a real pool` +
        (rate !== undefined ? ` (${(rate * 100).toFixed(1)}%).` : ".");

  if (l.devMints >= INDUSTRIAL_DEPLOYER_MINTS) {
    return check(
      "creator_history",
      "Creator history",
      "fail",
      `This wallet has issued ${n} mints.${reached} At this volume nobody is having ideas — this is an output of a machine, and roughly a quarter of everything on this feed comes from wallets like it.`,
    );
  }
  if (l.devMints >= SERIAL_DEPLOYER_MINTS && rate !== undefined && rate < DEAD_MINT_RATE) {
    return check(
      "creator_history",
      "Creator history",
      "fail",
      `This wallet has issued ${n} mints.${reached} A high count with almost nothing reaching a pool is a spam pipeline, not a track record.`,
    );
  }
  if (l.devMints >= SERIAL_DEPLOYER_MINTS) {
    return check(
      "creator_history",
      "Creator history",
      "warn",
      `This wallet has issued ${n} mints.${reached} For calibration: across 47 sampled fresh mints the MEDIAN deployer was on their 75th, so this is the middle of the population rather than an outlier.`,
    );
  }
  if (l.devMints >= REPEAT_DEPLOYER_MINTS) {
    return check(
      "creator_history",
      "Creator history",
      "warn",
      `This wallet has issued ${n} mints.${reached} Repeat deployers are not automatically bad, but you are not their first attempt.`,
    );
  }
  return readingPass(
    "creator_history",
    "Creator history",
    l.devMints <= 1
      ? "First mint from this wallet — the top fifth of the feed by this measure. There is no history to hold against it, which is not the same as a clean one: every serial deployer's first token looked exactly like this."
      : `This wallet has issued ${n} mints.${reached}`,
  );
}

/**
 * Other mints in the feed wearing this one's name.
 *
 * The only check here that no per-token audit can produce, however thorough,
 * because the evidence is not in the token — it is in its neighbours. Two mints
 * called CASHCOW twelve seconds apart are individually unremarkable and jointly
 * an impersonation play, and the reader watching rows scroll past will not
 * notice the first one by the time the second lands.
 *
 * Graded `warn` rather than `fail`: name collisions on Solana are also produced
 * by coincidence and by fifty people memeing the same news story within a
 * minute of each other, and this cannot tell those apart from a targeted
 * copycat. RugCheck's own "Copycat token" finding is the sharper instrument and
 * it lands in `vendor_flags`.
 */
function twinCheck(twins: string[] | undefined): LaunchCheck {
  if (!twins || twins.length === 0) {
    return absencePass(
      "name_collision",
      "Name collision",
      "No other launch currently in this feed shares its name or symbol. Only covers what the feed is holding — a copycat that launched an hour ago has already aged out.",
    );
  }
  return check(
    "name_collision",
    "Name collision",
    "warn",
    `${twins.length} other mint${twins.length === 1 ? "" : "s"} in this feed launched under the same name or symbol: ${twins
      .map((m) => `${m.slice(0, 6)}…${m.slice(-4)}`)
      .join(", ")}. Sometimes coincidence, sometimes a copy riding the original's search traffic — check which one people are actually buying before assuming this is it.`,
  );
}

/** RugCheck's creator-rug finding, which arrives inside a second and is worth the call. */
function rugHistoryCheck(risk: TokenRisk | undefined): LaunchCheck {
  if (!risk) {
    return check("rug_history", "Creator rug history", "unchecked", "No risk provider graded this mint yet.");
  }
  const hit = risk.risks.find((r) => /rug/i.test(r.name) && /creator|dev/i.test(r.name));
  if (hit) {
    return check("rug_history", "Creator rug history", "fail", `${risk.source}: ${hit.detail || hit.name}`);
  }
  return absencePass(
    "rug_history",
    "Creator rug history",
    `${risk.source} did not link this deployer to a previous rug. That is the absence of a finding, not a finding: a wallet it has never seen and a wallet it has cleared produce the same answer, and a deployer on their first token has nothing to find by construction.`,
  );
}

/**
 * LP lock, the check most likely to be read backwards.
 *
 * See the file header: on a bonding curve this number is structural noise, and
 * on the deepest pools on Solana it reads near zero. Answered only where it
 * describes a real, withdrawable pool.
 */
function lpCheck(l: LaunchObservation, risk: TokenRisk | undefined): LaunchCheck {
  if (onBondingCurve(l)) {
    return check(
      "lp_locked",
      "LP locked",
      "n/a",
      `Still on the ${l.launchpad} bonding curve. There is no LP to lock or pull yet — the curve holds the liquidity and nobody can withdraw it. Measured across 24 fresh mints, the published figure was 100% on nineteen of them and 0% on five, with nothing in between: that is a structural bit about the pool type, not a reading of the deployer's intent, and it is inverted on real markets (PUMP at $41.9M liquidity publishes 0.04%). What can take your money right now is the deployer selling their allocation into your buy.`,
    );
  }
  if (!risk || risk.lpLockedPct === undefined) {
    return check("lp_locked", "LP locked", "unchecked", "No risk provider reported an LP lock share for this pool.");
  }
  const p = risk.lpLockedPct;
  if (p >= 0.9) return readingPass("lp_locked", "LP locked", `${pct(p)} of LP locked or burned per ${risk.source}.`);
  if (p >= 0.5) return check("lp_locked", "LP locked", "warn", `Only ${pct(p)} of LP is locked per ${risk.source}; the rest can be withdrawn.`);
  return check(
    "lp_locked",
    "LP locked",
    "fail",
    `${pct(p)} of LP locked per ${risk.source} — effectively unlocked. The deployer can withdraw the pool without needing any authority over the mint.`,
  );
}

/** What the deployer still holds. Meaningful at every stage, unlike LP lock. */
function devHoldCheck(l: LaunchObservation): LaunchCheck {
  if (l.devHoldsPct === undefined) {
    return check(
      "dev_balance",
      "Deployer allocation",
      "unchecked",
      "The source did not report what the deployer holds. This is the most common gap on a fresh launch — the field was present on only 10 of 47 sampled mints — and it is the check that matters most while the token is still on its curve.",
    );
  }
  if (l.devHoldsPct >= DEV_HOLD_FAIL) {
    return check("dev_balance", "Deployer allocation", "fail", `The deployer holds ${pct(l.devHoldsPct)} of supply and can sell it into you at any moment.`);
  }
  if (l.devHoldsPct >= DEV_HOLD_WARN) {
    return check("dev_balance", "Deployer allocation", "warn", `The deployer holds ${pct(l.devHoldsPct)} of supply.`);
  }
  return readingPass("dev_balance", "Deployer allocation", `The deployer holds ${pct(l.devHoldsPct)} of supply.`);
}

/**
 * Top-ten concentration, answered only where it describes wallets.
 *
 * Two separate reasons this can be a lie, both already measured elsewhere in
 * this codebase: on a bonding curve the top holder IS the curve, and on a
 * graduated token the figure counts AMM pool accounts as holders. The first is
 * fatal and gets `n/a`; the second is a caveat carried in the detail text.
 */
function concentrationCheck(l: LaunchObservation): LaunchCheck {
  if (onBondingCurve(l)) {
    return check(
      "top_holders",
      "Top-10 concentration",
      "n/a",
      `Still on the ${l.launchpad} bonding curve, so the largest "holder" is the curve itself. Sampled fresh mints report 50% and 100% here for exactly that reason. The deployer allocation above is the concentration figure that means something at this stage.`,
    );
  }
  if (l.top10Pct === undefined) {
    return check("top_holders", "Top-10 concentration", "unchecked", "The source did not report a top-holder share.");
  }
  const caveat = " Counts AMM pool accounts as holders, so part of this may be pooled liquidity rather than a whale.";
  if (l.top10Pct >= TOP10_FAIL) {
    return check("top_holders", "Top-10 concentration", "fail", `Top 10 hold ${pct(l.top10Pct)} of supply.${caveat}`);
  }
  if (l.top10Pct >= TOP10_WARN) {
    return check("top_holders", "Top-10 concentration", "warn", `Top 10 hold ${pct(l.top10Pct)} of supply.${caveat}`);
  }
  return readingPass("top_holders", "Top-10 concentration", `Top 10 hold ${pct(l.top10Pct)} of supply.${caveat}`);
}

/**
 * Named vendor findings that no other check already covers.
 *
 * TWO WAYS THIS GOES WRONG, BOTH FIXED HERE AFTER SEEING THEM HAPPEN.
 *
 * Double counting. The first version failed this check whenever the vendor's
 * normalised score crossed 40, and that score is dominated by whichever risk
 * fired. A serial rugger therefore failed `creator_history`, `rug_history` AND
 * this one on a single piece of evidence, and the row read "3 failed" off one
 * fact. Findings already owned by a dedicated check are excluded below, and the
 * raw score is reported rather than used as a trigger.
 *
 * Structural false positives. On the 24 fresh mints sampled, the vendor's most
 * common danger was "Single holder ownership" — which on a bonding curve is the
 * CURVE, the same reason `top_holders` is n/a. "Low Liquidity" fires on every
 * pump.fun launch because they all start near $3.2k. Passing those through here
 * would smuggle back in exactly the noise the n/a states exist to keep out, so
 * the concentration, LP and liquidity families are excluded while the token is
 * still on its curve, and the n/a rows say so.
 */
const OWNED_BY_ANOTHER_CHECK = /rug|mint authority|freeze authority/i;
const STRUCTURAL_ON_A_CURVE = /holder|ownership|concentration|\blp\b|liquidity/i;

function vendorCheck(l: LaunchObservation, risk: TokenRisk | undefined): LaunchCheck {
  const curve = onBondingCurve(l);
  const relevant = (risk?.risks ?? []).filter(
    (r) => !OWNED_BY_ANOTHER_CHECK.test(r.name) && !(curve && STRUCTURAL_ON_A_CURVE.test(r.name)),
  );
  const danger = relevant.filter((r) => r.level === "danger");
  const warned = relevant.filter((r) => r.level === "warn");

  if (l.sus) {
    return check(
      "vendor_flags",
      "Vendor flags",
      "fail",
      `${l.source} flagged this mint as suspicious in its own listing${danger.length ? `; also ${danger.map((r) => r.name).join(", ")}` : ""}. Somebody else's judgement, not Nova's.`,
    );
  }
  if (danger.length > 0) {
    return check("vendor_flags", "Vendor flags", "fail", `${risk!.source}: ${danger.map((r) => r.name).join(", ")}. Somebody else's judgement, not Nova's.`);
  }
  if (warned.length > 0) {
    return check("vendor_flags", "Vendor flags", "warn", `${risk!.source}: ${warned.map((r) => r.name).join(", ")}.`);
  }
  if (!risk) {
    return check("vendor_flags", "Vendor flags", "unchecked", "No vendor has graded this mint yet, and the listing source raised no flag of its own.");
  }
  // The vendor's numeric score is deliberately NOT quoted here.
  //
  // It used to read "it grades the mint 1/100 where higher is riskier", which
  // hands the reader the exact trap this file's header documents: a 1 on a
  // nine-second-old mint is what you get when nothing has had time to happen,
  // and the sentence presented it as a clean bill from a grader that had looked.
  // The score is real and it belongs on the row where it is labelled as a
  // vendor's opinion; inside a check that has just PASSED, it reads as
  // corroboration and it is not.
  return absencePass(
    "vendor_flags",
    "Vendor flags",
    `${risk.source} raised nothing beyond what the checks above already cover. On a token this young that is close to meaningless: its low scores are produced by an absence of history, not by an audit, and a mint minutes old has no history to have.` +
      (curve ? " Its concentration and liquidity findings are excluded here because the bonding curve produces them on every launch regardless of the token." : ""),
  );
}

/**
 * Everything above, in one verdict.
 *
 * `risk` is optional and its absence is the normal state for the first second
 * or two of a launch's life: the row lands from the list call, and the risk
 * summary is a second request that has not returned yet. Triage without it is
 * still worth showing — creator history, authorities and deployer allocation
 * all come free with the listing — so this function produces a partial verdict
 * and reports `unchecked` honestly rather than waiting.
 */
export function triageLaunch(
  l: LaunchObservation,
  risk?: TokenRisk,
  completedInMs?: number,
  twins?: string[],
): LaunchTriage {
  const checks: LaunchCheck[] = [
    creatorCheck(l),
    rugHistoryCheck(risk),
    ...authorityChecks(l),
    devHoldCheck(l),
    lpCheck(l, risk),
    concentrationCheck(l),
    twinCheck(twins),
    vendorCheck(l, risk),
  ];

  const unchecked = checks.filter((c) => c.state === "unchecked").length;
  // Passes that came from somebody looking at a value, as opposed to somebody
  // not finding anything. On a fresh launchpad mint this is usually just the
  // two authority reads, and a reader who thinks eight ticks means eight
  // verifications has been misled by the shape of the row.
  const readings = checks.filter((c) => c.state === "pass" && c.basis === "reading").length;
  // n/a is excluded from `measured` on purpose. A check that cannot apply did
  // not verify anything, and counting it toward "5 of 8 checks passed" would
  // inflate the reassurance with structural non-answers.
  const measured = checks.filter((c) => c.state === "pass" || c.state === "warn" || c.state === "fail").length;

  const verdict: LaunchVerdict = checks.some((c) => c.state === "fail")
    ? "avoid"
    : checks.some((c) => c.state === "warn")
      ? "caution"
      : "unverified";

  return {
    verdict,
    checks,
    measured,
    readings,
    total: checks.length,
    unchecked,
    riskScore: risk?.score,
    riskSource: risk?.source,
    completedInMs,
  };
}

/**
 * The one-line summary a row shows without the reader opening anything.
 *
 * Always carries the check counts. "AVOID" alone is a claim; "AVOID — 2 of 8
 * checks failed, 1 could not run" is an argument, and the reader can tell
 * whether the verdict rests on evidence or on absence.
 */
export function triageHeadline(t: LaunchTriage): string {
  const failed = t.checks.filter((c) => c.state === "fail");
  const warned = t.checks.filter((c) => c.state === "warn");
  const parts: string[] = [];
  if (failed.length) parts.push(`${failed.length} failed`);
  if (warned.length) parts.push(`${warned.length} warning${warned.length === 1 ? "" : "s"}`);
  if (t.unchecked) parts.push(`${t.unchecked} not checked`);
  const body = parts.length ? parts.join(", ") : "nothing found yet";
  // The reading count travels with the verdict, because "6 of 8 checks could
  // run" and "2 of those rest on a direct reading" are the two halves of the
  // same sentence, and the first alone reads far stronger than the evidence is.
  return (
    `${t.verdict.toUpperCase()} — ${body} (${t.measured} of ${t.total} checks could run; ` +
    `${t.readings} pass${t.readings === 1 ? "" : "es"} from a direct reading, the rest from nobody finding anything)`
  );
}
