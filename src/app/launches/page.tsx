"use client";

import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PageTitle } from "@/components/ui/PageTitle";
import { Hint } from "@/components/ui/Hint";
import Link from "next/link";
import { apiGet, fmtUsd, fmtNum } from "@/lib/client";
import { TokenMark, Empty } from "@/components/ui/bits";
import { triageHeadline } from "@/lib/engine/triage";
import { holdPumpPortal, PUMPPORTAL_NAME } from "@/lib/live/pumpportal";
import { CURVE_CAP, RPC_WS_NAME, setWatched } from "@/lib/live/rpc-ws";
import { describeSocket, socketsSnapshot, socketsSnapshotServer, subscribeSockets, type SocketSnapshot } from "@/lib/live/socket";
import type { LaunchFeed } from "@/lib/api/launches";
import type { LaunchCheck, TokenLaunch } from "@/lib/types";

/**
 * The push chip's three honest states, from the socket snapshot alone.
 *
 * CONNECTED means the socket is open AND the creation subscription was
 * acknowledged. Open-but-unacked is not connected for this page's purposes:
 * the server may not be sending creations at all, and "push: connected"
 * over a feed the poll is actually carrying is the silent-stale lie this
 * chip exists to refuse. Exported for the regression test.
 */
export function pushChip(
  s: SocketSnapshot | undefined,
  pushed: number,
  now: number,
): { up: boolean; label: string; cls: string; title: string } {
  const sub = s?.subscriptions.find((x) => x.key === "newToken");
  const d = describeSocket(s, now);
  const receipt =
    "\n\nPushed rows are stamped with RECEIPT time on this machine's clock, uncorrected — the frame carries no " +
    "timestamp — and stay undated until a poll lists the mint. Only then is a push lag stateable.";
  if (d.up && sub?.state === "subscribed") {
    return {
      up: true,
      label: `push: ${d.label} · ${pushed} pushed this session`,
      cls: "pos",
      title:
        `PumpPortal creation stream is open and the subscription was acknowledged ${sub.ackedAt ? `${Math.round((now - sub.ackedAt) / 1000)}s ago` : ""}. ` +
        `${pushed} creation frame${pushed === 1 ? "" : "s"} accepted into the feed since this tab opened; reconnects ${s?.reconnects ?? 0}. ` +
        "The 3s poll keeps running beside it — the push adds rows sooner, the poll dates and prices them." +
        receipt,
    };
  }
  if (d.up) {
    return {
      up: false,
      label: `push: open, ${sub?.state === "unacked" ? "subscribe UNACKED" : "subscribe pending"} — polling`,
      cls: "warn",
      title:
        "The socket is open but the creation subscription has " +
        (sub?.state === "unacked" ? "not been acknowledged in 10s, which counts as NOT subscribed" : "not been acknowledged yet") +
        ". Rows come from the 3s poll until it is." +
        receipt,
    };
  }
  return {
    up: false,
    label: `push: ${s ? d.label : "not started"} — polling`,
    cls: s?.wanted ? "neg" : "faint",
    title:
      (s
        ? `The PumpPortal socket is ${s.state}${s.lastCloseReason ? ` (${s.lastCloseReason})` : ""}${s.nextRetryAt ? `, retrying in ${Math.max(0, Math.round((s.nextRetryAt - now) / 1000))}s with backoff` : ""}.`
        : "The PumpPortal socket has not been opened.") +
      ` Rows come from the 3s poll alone until it connects; ${pushed} were pushed earlier this session.` +
      receipt,
  };
}

// New Solana pools and launchpad graduations, triaged as they land.
//
// The scanner ranks what is already moving. This ranks nothing: a token
// eleven seconds old has one price print and three holders, so there is no
// momentum to rank it by, and any score built from that would be almost
// entirely made of factors that stood down. What a reader needs in the first
// minute is not a number, it is a decision — and the decision is made of
// checks, each of which either ran or did not.
//
// So there is no green verdict anywhere on this page. `unverified` is the
// ceiling, and every row states how many of its checks could actually run.

// Half the feed's own 3s refresh gap, so the feed refreshes on a clean 3s
// cadence instead of drifting out to 4s or 5s waiting for the next page poll.
// The extra calls cost nothing: in the static build they hit the in-process
// feed, which self-throttles, and in server mode they are a local round trip.
const POLL_MS = 1_500;

/** Age that ticks without refetching, so the clock never lies between polls. */
function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Seconds-precision age. A launch feed that rounds to "1m" has lost the plot. */
function ageLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const VERDICT_CLASS: Record<string, string> = {
  avoid: "chip-neg",
  caution: "chip-warn",
  // Deliberately the neutral chip. There is no green here and there never
  // should be: `unverified` means nothing failed YET, on a token too young to
  // have a record, and painting that the same colour as a passed audit is the
  // single most dangerous thing this page could do.
  unverified: "chip",
};

/**
 * A glyph per check state, with `pass` split by what the pass rests on.
 *
 * A solid tick is a reading: somebody looked at a value and it was good. A
 * hollow ring is an absence: nobody found anything, which on a token this young
 * is mostly a statement about how little has had time to happen. They used to
 * render identically, so a strip reading eight ticks claimed eight
 * verifications where two were measurements and the rest were silence — the
 * exact confusion the whole triage model exists to prevent, reintroduced at the
 * last step by the drawing code.
 */
function glyphOf(c: LaunchCheck): { glyph: string; cls: string } {
  switch (c.state) {
    case "pass":
      return c.basis === "absence" ? { glyph: "○", cls: "dim" } : { glyph: "✓", cls: "pos" };
    case "warn":
      return { glyph: "!", cls: "warn" };
    case "fail":
      return { glyph: "✕", cls: "neg" };
    case "unchecked":
      return { glyph: "—", cls: "faint" };
    default:
      return { glyph: "·", cls: "faint" };
  }
}

const STATE_WORD: Record<LaunchCheck["state"], string> = {
  pass: "PASS",
  warn: "WARNING",
  fail: "FAILED",
  unchecked: "NOT CHECKED",
  "n/a": "DOES NOT APPLY YET",
};

/** The checks as glyphs. Hovering any one gives the sentence behind it. */
function CheckStrip({ launch }: { launch: TokenLaunch }) {
  return (
    <span className="inline-flex gap-[3px] items-center">
      {launch.triage.checks.map((c) => {
        const { glyph, cls } = glyphOf(c);
        return (
          <span
            key={c.key}
            className={`${cls} text-[11px] leading-none w-[11px] text-center`}
            title={
              `${c.name}: ${STATE_WORD[c.state]}` +
              (c.assumed ? " (assumed from absent data, not measured)" : "") +
              (c.state === "pass"
                ? c.basis === "absence"
                  ? " — from nobody finding anything, not from a reading"
                  : " — from a direct reading"
                : "") +
              `\n${c.detail}`
            }
          >
            {glyph}
          </span>
        );
      })}
    </span>
  );
}

/**
 * The source's own indexing floor, measured across a sustained 1/s run.
 *
 * It cannot publish a pool it has not indexed, so this is the fastest the
 * fastest row can honestly be. A minimum lag materially under it is not a fast
 * feed, it is a slow clock.
 */
const SOURCE_FLOOR_MS = 2_300;

/** Curve fraction at which a mint is close enough to graduating to filter for. */
const NEAR_GRADUATION = 0.8;

/**
 * The expanded panel's sighting sentence. Exported for the regression test.
 *
 * A promoted row — first seen on the bonding curve, later seen graduated —
 * keeps its curve-era `firstSeenAt` while the graduation source re-dates
 * `poolCreatedAt` to the migrated pool's creation. Raw firstSeenAt arithmetic
 * on such a row renders "seen -116.7s after the source's pool-creation time":
 * a fabricated negative, reproduced live on exactly the rows gradSeenAt was
 * added to fix, because this line was written before promotion existed and
 * never learned about it. Graduation rows therefore anchor on the graduation
 * sighting, the same quantity gradLagOf feeds the header statistic.
 */
export function sightingLine(l: TokenLaunch): string {
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  // A pushed row that no poll has listed yet has no creation time at all —
  // the socket frame carries none — so the only honest sentence is when it
  // was received, and by whose clock.
  if (l.poolCreatedAt === undefined) {
    return (
      `pushed by ${l.source}, received ${new Date(l.firstSeenAt).toISOString()} on this machine's clock (uncorrected) — ` +
      "dated by: not yet; no polled source has listed this mint, so no lag can be stated"
    );
  }
  if (l.event === "graduation") {
    return `graduation seen ${secs((l.gradSeenAt ?? l.firstSeenAt) - l.poolCreatedAt)} after the source's pool-creation time`;
  }
  // Seen by push, dated by a poll: the difference is the socket's lead over
  // the source's own timestamp, and it can be negative on a clock that runs
  // behind — which is stated rather than clamped.
  if (l.datedBy && l.datedBy !== l.source) {
    const delta = l.firstSeenAt - l.poolCreatedAt;
    return (
      `seen by push (${l.source}) ${secs(Math.abs(delta))} ${delta < 0 ? "BEFORE" : "after"} the pool-creation time ` +
      `${l.datedBy} published — receipt is this machine's clock, uncorrected` +
      (delta < 0 ? "; a negative reading means this clock runs behind the source's, not that the push beat the chain" : "")
    );
  }
  return `seen ${secs(l.firstSeenAt - l.poolCreatedAt)} after the source's pool-creation time`;
}

/**
 * Evidence that this machine's clock is FLATTERING the figures above.
 *
 * WHICH DIRECTION A NEGATIVE LAG ACTUALLY PROVES, because the first version of
 * this function got it backwards and the live feed caught it.
 *
 * Every figure here is `firstSeenAt - poolCreatedAt`, one timestamp from the
 * local clock and one from the source. With the local clock offset by `s`
 * (positive = ahead), that arithmetic is `true_lag + s`. So:
 *
 *   clock AHEAD   every lag is INFLATED. It can never go negative, and there is
 *                 no upper bound to test a lag against, so this direction is
 *                 not detectable from these numbers at all. It is also the safe
 *                 direction — it makes the feed look worse than it is.
 *
 *   clock BEHIND  every lag is REDUCED by the offset. This is the dangerous
 *                 direction and the one that had no signal, and it is not
 *                 hypothetical: this machine bracketed at 2.39s behind on one
 *                 day and 2.85s weeks later, drifting, against Cloudflare and
 *                 Google both. It is also the only direction that is testable,
 *                 twice over — which is why both tests below point at it.
 *
 * Labelling `lagMinMs < 0` as "clock ahead" was exactly wrong: a clock running
 * ahead cannot produce it. Seeing a pool before the source says it existed
 * means our "now" reads EARLIER than the source's.
 */
export function clockSkewHint(feed: LaunchFeed | null | undefined): { label: string; title: string } | null {
  if (!feed) return null;
  // Both pipelines, not just mints.
  //
  // Graduations cross zero FIRST — they arrive within a few seconds, so a
  // constant clock offset is a large fraction of the figure, while mints lag
  // longer and absorb the same offset without ever going negative. Reading only
  // the mint minimum, this hint stayed silent while the row above it displayed
  // "grad lag -0s": a negative latency shown as a measurement, which is the
  // precise thing the mint-side check was written to prevent.
  //
  // The more negative of the two wins, because the worse impossibility is the
  // better estimate of the offset.
  const candidates: number[] = [];
  if (feed.lagMinMs !== null && feed.lagSamples >= 3) candidates.push(feed.lagMinMs);
  if (feed.gradLagMinMs !== null && feed.gradLagSamples >= 3) candidates.push(feed.gradLagMinMs);
  if (candidates.length === 0) return null;
  const observed = Math.min(...candidates);
  // The floor below was measured on the MINT source and belongs only to it.
  // The graduation pipeline's own measured minimum is 1.0s, well under it, so
  // running the below-floor test on the combined minimum made a genuinely fast
  // graduation read as evidence of a slow clock. Negative stays a combined
  // test — an impossible reading is impossible whichever pipeline produced it —
  // but "suspiciously fast" is only meaningful against the floor of the
  // pipeline that was measured.
  const mintObserved = feed.lagMinMs !== null && feed.lagSamples >= 3 ? feed.lagMinMs : null;
  const tail =
    "\n\nThe opposite direction — a clock running ahead — inflates these figures instead, and cannot be " +
    "detected here at all: it never produces an impossible reading, only a pessimistic one.\n\n" +
    "`npm run probe:launches` brackets the offset off the HTTP Date header against three independent " +
    "servers and reports every figure both raw and corrected.";
  if (observed < 0) {
    return {
      label: "clock behind",
      title:
        `The fastest row on this page was seen ${(Math.abs(observed) / 1000).toFixed(1)}s BEFORE the source ` +
        "says its pool was created, which is impossible — so this machine's clock reads earlier than the " +
        "source's. That difference is SUBTRACTED from every lag figure above, making the feed look faster " +
        "than it is by however far the clock is off." +
        tail,
    };
  }
  if (mintObserved !== null && mintObserved >= 0 && mintObserved < SOURCE_FLOOR_MS) {
    return {
      label: "clock may be behind",
      title:
        `The fastest row on this page was seen ${(mintObserved / 1000).toFixed(1)}s after its pool was created, ` +
        `which is under the ${(SOURCE_FLOOR_MS / 1000).toFixed(1)}s floor this source was measured at over a ` +
        "sustained run. It cannot publish a pool it has not indexed yet, so the likeliest explanation is a " +
        "local clock running behind the source's — which subtracts itself from every figure above." +
        "\n\nThis one is evidence, not proof: the source could genuinely have got quicker." +
        tail,
    };
  }
  return null;
}

function OriginCell({ launch }: { launch: TokenLaunch }) {
  const { devMints, devMigrations, launchpad, venue } = launch;
  const where = launchpad ?? venue;
  if (devMints === undefined) {
    return (
      <td className="px-2 text-[10px] faint" title="the source published no creator history for this deployer">
        {where ?? "—"}
      </td>
    );
  }
  const serial = devMints >= 50;
  const repeat = devMints >= 5;
  return (
    <td
      className={`px-2 text-[10px] ${serial ? "neg" : repeat ? "warn" : "faint"}`}
      title={
        (where ? `Launched on ${where}. ` : "") +
        `This deployer has issued ${devMints.toLocaleString()} mints` +
        (devMigrations !== undefined ? `, ${devMigrations.toLocaleString()} of which reached a real pool` : "") +
        ". A first mint is not a guarantee; every serial deployer had one."
      }
    >
      {where ? `${where} · ` : ""}
      {devMints === 1 ? "1st mint" : `${fmtNum(devMints)} mints`}
    </td>
  );
}

export default function LaunchesPage() {
  const now = useNow();
  const [feed, setFeed] = useState<LaunchFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [paused, setPaused] = useState(false);
  const [minLiq, setMinLiq] = useState("0");
  const [hideSerial, setHideSerial] = useState(false);
  const [hideAvoid, setHideAvoid] = useState(false);
  const [nearGrad, setNearGrad] = useState(false);
  const [cleanOnly, setCleanOnly] = useState(false);
  const [venue, setVenue] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  /** Mints seen in a previous render, so only genuinely new rows flash. */
  const known = useRef<Set<string>>(new Set());
  const [arrived, setArrived] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (paused) return;
    let dead = false;
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const body = await apiGet<{ feed: LaunchFeed | null }>("/api/launches");
        if (dead) return;
        setLoaded(true);
        setError(null);
        if (!body.feed) {
          setFeed(null);
          return;
        }
        const fresh = new Set<string>();
        for (const l of body.feed.launches) {
          if (!known.current.has(l.mint)) fresh.add(l.mint);
          known.current.add(l.mint);
        }
        setFeed(body.feed);
        setArrived(fresh);
        // The twenty newest rows still on a curve whose curve account is
        // known — only the push carries it — get an accountSubscribe, so a
        // graduation is noticed when the account changes and the poll then
        // confirms it. Diffed inside `setWatched`; asking every poll is free.
        setWatched("launches", {
          curves: body.feed.launches
            .filter((l) => l.event === "pool" && l.curveAccount)
            .sort((a, b) => b.firstSeenAt - a.firstSeenAt)
            .slice(0, CURVE_CAP)
            .map((l) => ({ account: l.curveAccount!, mint: l.mint, symbol: l.symbol || undefined })),
        });
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
          if (!dead) setArrived(new Set());
        }, 2400);
      } catch (err) {
        if (!dead) {
          setLoaded(true);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    // Only while somebody is looking.
    //
    // The same rule client.ts's useApi already enforces, and it matters more
    // here than anywhere: this is the fastest poll in the app, and a launch feed
    // forgotten in a background tab would keep asking Jupiter for new pools
    // every three seconds, indefinitely, on someone's battery — for rows that
    // will have aged out of relevance long before they are looked at.
    let timer: ReturnType<typeof setInterval> | undefined;
    // The push socket is held on exactly the poll's terms: open while this
    // page is visible, released when it is hidden or gone. A socket left
    // open for a tab nobody is reading is the background-battery bug the
    // poll already fixed, wearing a WebSocket.
    let releasePush: (() => void) | undefined;
    const start = () => {
      if (timer !== undefined) return;
      timer = setInterval(load, POLL_MS);
      releasePush ??= holdPumpPortal();
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      releasePush?.();
      releasePush = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Refetch immediately on the way back, or the first thing seen is a
        // page of launches that stopped being launches while the tab was hidden.
        void load();
        start();
      } else {
        stop();
      }
    };

    if (typeof document === "undefined" || document.visibilityState === "visible") {
      load();
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      dead = true;
      stop();
      setWatched("launches", { curves: [] });
      document.removeEventListener("visibilitychange", onVisibility);
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [paused]);

  const sockets = useSyncExternalStore(subscribeSockets, socketsSnapshot, socketsSnapshotServer);
  const pushSock = sockets.find((s) => s.name === PUMPPORTAL_NAME);
  const rpcSock = sockets.find((s) => s.name === RPC_WS_NAME);

  const venues = useMemo(() => {
    const set = new Set<string>();
    for (const l of feed?.launches ?? []) {
      const v = l.launchpad ?? l.venue;
      if (v) set.add(v);
    }
    return [...set].sort();
  }, [feed]);

  const rows = useMemo(() => {
    const liq = Number(minLiq) || 0;
    return (feed?.launches ?? []).filter((l) => {
      // A launch with no liquidity figure yet is NOT a launch with zero
      // liquidity, and a "min liquidity" filter must not delete it. Those are
      // the two-of-thirty freshest rows Jupiter has not priced — the ones this
      // page exists for.
      if (liq > 0 && l.liquidityUsd !== undefined && l.liquidityUsd < liq) return false;
      if (hideSerial && (l.devMints ?? 0) >= 50) return false;
      if (hideAvoid && l.triage.verdict === "avoid") return false;
      if (cleanOnly && l.triage.verdict !== "unverified") return false;
      // A mint with no published curve figure is not a mint at 0%, so this
      // filter drops it rather than judging it. Same rule as min-liquidity
      // above: an absent measurement must not be filtered as though it were a
      // low one.
      // A token that HAS graduated is not near graduating, and the row already
      // knows it: its own Curve cell renders "n/a — graduated, the curve is
      // gone". `mergeLaunch` deliberately preserves `bondingCurvePct` through
      // graduation, so the stale value sailed past this threshold and the filter
      // contradicted the column beside it on the same row — two of three matches
      // in review were graduations. A sniper asking "what is about to migrate"
      // was handed tokens where migration had already happened, which is the one
      // set they cannot act on.
      if (nearGrad && l.event === "graduation") return false;
      if (nearGrad && !(l.bondingCurvePct !== undefined && l.bondingCurvePct >= NEAR_GRADUATION)) return false;
      if (venue !== "all" && (l.launchpad ?? l.venue) !== venue) return false;
      return true;
    });
  }, [feed, minLiq, hideSerial, hideAvoid, cleanOnly, nearGrad, venue]);

  /**
   * How the verdict is distributed across the whole feed, right now.
   *
   * Without it AVOID is uninterpretable. Measured across 184 live rows it lands
   * on about 70% of them, and a reader who does not know that reads each one as
   * a specific warning rather than as the base rate of a market where most new
   * mints are junk. Shown rather than tuned away: the checks were validated
   * against the graduation cohort and left alone, so the honest fix is to say
   * what the number IS instead of massaging it down.
   */
  const mix = useMemo(() => {
    const all = feed?.launches ?? [];
    const n = all.length;
    if (n === 0) return null;
    const count = (v: string) => all.filter((l) => l.triage.verdict === v).length;
    return { n, avoid: count("avoid"), caution: count("caution"), unverified: count("unverified") };
  }, [feed]);

  const lag = feed?.lagP50Ms;
  const stale = feed?.stale === true;
  const sinceOk = feed && feed.lastSuccessAt > 0 ? now - feed.lastSuccessAt : null;
  const clockNote =
    "\n\nUNCORRECTED. This is local-clock arithmetic: your clock minus the source's timestamp, and a " +
    "browser cannot bracket the difference because none of these APIs expose the HTTP Date header to " +
    "scripts — checked, and all four send no Access-Control-Expose-Headers at all. A clock running " +
    "BEHIND the source subtracts itself from this number and flatters it; a clock running ahead " +
    "inflates it. `npm run probe:launches` brackets the offset against three independent servers and " +
    "reports every figure both raw and corrected.";
  const skew = clockSkewHint(feed);
  const push = pushChip(pushSock, feed?.pushed ?? 0, now);
  const curveSubs = rpcSock?.subscriptions.filter((s) => s.key.startsWith("account:")) ?? [];
  const curvesOn = curveSubs.filter((s) => s.state === "subscribed").length;

  return (
    <div className="p-3 flex flex-col gap-2 h-full min-h-0">
      <div className="flex items-center gap-2 flex-wrap">
        <PageTitle title="LAUNCH FEED" lede="New mints and pools, triaged the second they appear" />
        {/* The push, in the same two states the socket has. Never "live"
            without a last-frame age, never silent about falling back. */}
        {!paused && (
          <span className={`flex items-center gap-1.5 text-[10.5px] num ${push.cls}`} title={push.title}>
            {push.up ? <span className="live-dot" /> : <span>○</span>}
            {push.label}
          </span>
        )}
        {feed && feed.pushLagSamples > 0 && (
          <span
            className="text-[10.5px] num dim"
            title={
              "Median of (receipt time of the push on this machine's clock) minus (the pool-creation time a poll later " +
              `published), over the ${feed.pushLagSamples} pushed row${feed.pushLagSamples === 1 ? "" : "s"} a poll has dated ` +
              "— seen by push, dated by jupiter. Kept separate from the poll's own lag so neither flatters the other. " +
              `Minimum ${feed.pushLagMinMs === null ? "—" : `${(feed.pushLagMinMs / 1000).toFixed(1)}s`}; a negative figure means this ` +
              "clock runs behind the source's, not that the push beat the chain." +
              (feed.undated > 0 ? `\n\n${feed.undated} pushed row${feed.undated === 1 ? "" : "s"} still undated — no poll has listed them yet.` : "") +
              clockNote
            }
          >
            push lag {feed.pushLagP50Ms === null ? "—" : `${(feed.pushLagP50Ms / 1000).toFixed(1)}s`}
            <span className="faint"> n={feed.pushLagSamples}</span>
          </span>
        )}
        {!paused && rpcSock && curveSubs.length > 0 && (
          <span
            className={`text-[10.5px] num ${rpcSock.state === "open" && curvesOn > 0 ? "dim" : "warn"}`}
            title={
              `accountSubscribe on the bonding curve of the ${CURVE_CAP} newest on-curve rows whose curve account is known (only the push carries it). ` +
              `${curvesOn} acknowledged, ${curveSubs.filter((s) => s.state === "sent").length} awaiting ack, ${curveSubs.filter((s) => s.state === "unacked").length} unacked (= not subscribed). ` +
              `Socket ${describeSocket(rpcSock, now).label}. A curve account changing makes the alert monitor re-read the feed now; the 3s poll confirms any graduation.`
            }
          >
            curves {curvesOn}/{curveSubs.length} watched
          </span>
        )}
        {feed && (
          <span
            className="flex items-center gap-1.5 text-[10.5px] dim num ml-2"
            title={
              stale
                ? "The feed is not currently receiving data. This rate describes the rows still on screen, which have stopped being updated."
                : "Pools created in the last 60 seconds, counted from the feed's own rows. Not a rate extrapolated from how long this tab has been open."
            }
          >
            {/* No pulsing dot on a dead feed. The dot is the single strongest
                "this is live" signal on the page and it kept beating through a
                74-second outage. */}
            {stale ? <span className="text-[var(--neg)]">■</span> : <span className="live-dot" />}
            {feed.perMinute}/min ·{" "}
            {feed.addedLastPass === null ? (
              <span className="neg" title="the last poll did not reach the source, so nothing can be said about arrivals">
                last pass failed
              </span>
            ) : (
              `+${feed.addedLastPass} last pass`
            )}
          </span>
        )}
        {feed && (
          <span
            className="text-[10.5px] num dim"
            title={
              "Median of (when this tab first saw the row) minus (the pool creation time the source published), " +
              "for NEW MINTS only. Graduations are a separate, much slower pipeline and have their own figure " +
              "beside this one — averaging the two would hide both.\n\n" +
              `From ${feed.lagSamples} mint${feed.lagSamples === 1 ? "" : "s"} that launched AFTER this feed opened. ` +
              "The rows already on screen when you arrived were backfilled from the source's existing page, so their " +
              "apparent age says when you opened the tab, not how fast the feed is — they are excluded here and shown " +
              "in the list anyway.\n\n" +
              `p90 ${feed.lagP90Ms === null ? "—" : `${(feed.lagP90Ms / 1000).toFixed(1)}s`} · ` +
              `min ${feed.lagMinMs === null ? "—" : `${(feed.lagMinMs / 1000).toFixed(1)}s`}` +
              clockNote +
              (feed.windowSeconds !== null
                ? `\n\nThe last listing page spanned ${feed.windowSeconds.toFixed(0)}s of Solana. That endpoint caps ` +
                  `at 30 rows with no cursor, so if the span ever falls near the ${POLL_MS / 1000}s poll interval, ` +
                  "launches are dropping off the back unseen."
                : "")
            }
          >
            mint lag{" "}
            {/* A frozen feed's lag figure describes a moment that has passed.
                Dashed rather than left standing at its last good value. */}
            {stale ? (
              <span className="neg" title="no successful poll recently — this figure would describe a moment that has passed">
                —
              </span>
            ) : feed.lagSamples === 0 ? (
              <span className="faint" title="no mint has arrived since this feed opened yet">
                measuring…
              </span>
            ) : (
              <>
                {lag === null || lag === undefined ? "—" : `${(lag / 1000).toFixed(1)}s`}
                <span className="faint"> n={feed.lagSamples}*</span>
              </>
            )}
          </span>
        )}
        {/* The verdict's own base rate, because AVOID on most of the feed is a
            fact about the market and reads as a fact about the row. */}
        {mix && (
          <span
            className="text-[10.5px] num dim"
            title={
              `Of ${mix.n} rows in the feed right now: ${mix.avoid} AVOID, ${mix.caution} CAUTION, ` +
              `${mix.unverified} UNVERIFIED.\n\n` +
              "AVOID lands on most of a new-mint feed and that is the market, not a verdict tuned to alarm. " +
              "The creator thresholds behind it were re-measured against two populations: they fail 33% of " +
              "brand-new mints but only 3% of the mints that went on to graduate, so they separate the two " +
              "rather than condemning everything.\n\n" +
              "The number is shown instead of tuned down because tuning it would be the easy way to make a " +
              "check look useful. Use 'unverified only' for the top of the funnel."
            }
          >
            mix{" "}
            <span className="neg">{Math.round((100 * mix.avoid) / mix.n)}%</span>
            <span className="faint">/</span>
            <span className="warn">{Math.round((100 * mix.caution) / mix.n)}%</span>
            <span className="faint">/</span>
            <span>{Math.round((100 * mix.unverified) / mix.n)}%</span>
          </span>
        )}
        {/* Both directions of clock skew, not just the flattering-to-nobody
            one. A clock running behind subtracts itself from every figure
            above and used to pass without comment. */}
        {feed && !stale && skew && (
          <span className="text-[10.5px] warn" title={skew.title}>
            ⚠ {skew.label}
          </span>
        )}
        {/* Graduations reported separately because they are an order of
            magnitude slower and were previously excluded from the headline
            entirely — see LaunchFeed.gradLagP50Ms. */}
        {feed && (
          <span
            className="text-[10.5px] num dim"
            title={
              "Median lag for GRADUATIONS — a launchpad curve completing into a real AMM pool.\n\n" +
              `From ${feed.gradLagSamples} graduation${feed.gradLagSamples === 1 ? "" : "s"} that happened after the ` +
              "graduation sweep started. A row this feed was already watching on the curve when it graduated " +
              "measures from the moment the graduation itself was first seen, not from the row's first " +
              "sighting — the two differ by the curve's whole lifetime.\n\n" +
              "This used to be the slow half of the feed by an order of magnitude — around two minutes, because " +
              "GeckoTerminal's new-pool index was the only graduation source wired in and it runs 18-94s behind " +
              "the chain before any polling interval is added. Jupiter's own pool API publishes a graduated list " +
              "and answers this app's origin, and measured head to head over seven minutes it arrived at p50 3.0s " +
              "against GeckoTerminal's 40.0s, leading on every graduation both of them saw.\n\n" +
              "GeckoTerminal is still polled for pools opened straight onto an AMM, which no launchpad feed lists. " +
              "A graduation only it catches really did take that long to arrive, so those are counted here too and " +
              "this figure is the blended truth rather than the best case.\n\n" +
              "pump.fun's own board is fresher still and cannot be read from a browser: it allowlists its own " +
              "origin and 403s everything else, and Origin is a header a page is not allowed to set. Watching the " +
              "PumpSwap program over the public RPC costs ~4,020 MB/hr for about two pool creations a minute." +
              clockNote
            }
          >
            grad lag{" "}
            {stale ? (
              <span className="neg">—</span>
            ) : feed.gradLagSamples === 0 ? (
              <span className="faint" title="no graduation has been observed since the sweep started">
                measuring…
              </span>
            ) : (
              <>
                {feed.gradLagP50Ms === null ? "—" : `${(feed.gradLagP50Ms / 1000).toFixed(0)}s`}
                <span className="faint"> n={feed.gradLagSamples}*</span>
              </>
            )}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <label className="text-[11px] dim flex items-center gap-1.5">
            min liq $
            <input value={minLiq} onChange={(e) => setMinLiq(e.target.value)} className="input w-[80px]" />
          </label>
          <select value={venue} onChange={(e) => setVenue(e.target.value)} className="input text-[11px]">
            <option value="all">all venues</option>
            {venues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <button
            className={`btn text-[11px] ${hideSerial ? "btn-primary" : ""}`}
            onClick={() => setHideSerial((x) => !x)}
            title="Hide launches whose deployer has issued 50 or more mints. Sampled pages carry creators at 3,911 and 5,623 mints."
          >
            no serial deployers
          </button>
          <button
            className={`btn text-[11px] ${hideAvoid ? "btn-primary" : ""}`}
            onClick={() => setHideAvoid((x) => !x)}
            title="Hide rows where at least one triage check failed."
          >
            hide AVOID
          </button>
          <button
            className={`btn text-[11px] ${cleanOnly ? "btn-primary" : ""}`}
            onClick={() => setCleanOnly((x) => !x)}
            title={
              "Show only rows where NO check failed and none warned — the best this page will ever say about a " +
              "launch.\n\nThis is the top of the funnel, not a recommendation: UNVERIFIED means nothing has been " +
              "found yet on a token far too young to have a record, and most of these checks pass by nobody " +
              "finding anything rather than by a reading."
            }
          >
            unverified only
          </button>
          <button
            className={`btn text-[11px] ${nearGrad ? "btn-primary" : ""}`}
            onClick={() => setNearGrad((x) => !x)}
            title={
              `Show only mints at or past ${NEAR_GRADUATION * 100}% of their bonding curve — the ones closest to ` +
              "graduating into a real pool.\n\nRows whose launchpad publishes no curve figure are hidden by this " +
              "filter rather than treated as 0%: an unmeasured curve is not a low one."
            }
          >
            near graduation
          </button>
          <button className={`btn text-[11px] ${paused ? "btn-danger" : ""}`} onClick={() => setPaused((x) => !x)}>
            {paused ? "▶ resume" : "⏸ pause"}
          </button>
        </div>
      </div>

      {/* The feed has stopped receiving data and the rows are frozen.
          Everything above this line is deliberately neutered when that happens
          — the dot, the arrival count, both lag figures — because the failure
          being fixed here is a page that kept asserting liveness through a
          74-second outage while looking exactly like a quiet market. */}
      {stale && feed && (
        <div className="px-3 py-2 rounded border border-[rgba(255,77,109,0.45)] bg-[rgba(255,77,109,0.09)] text-[11.5px] neg">
          <b>FEED STALLED — these rows are frozen.</b> No successful poll for{" "}
          {sinceOk === null ? "the whole session" : `${Math.round(sinceOk / 1000)}s`}
          {feed.failures > 0 && ` (${feed.failures} failed attempt${feed.failures === 1 ? "" : "s"})`}.
          {feed.lastError && <span className="dim"> Last error: {feed.lastError}.</span>}{" "}
          <span className="dim">
            Ages keep ticking because the clock is local; nothing new is arriving. An empty market and a
            dead connection look identical from here, so this says which it is. Polling continues and
            the feed recovers on its own.
          </span>
        </div>
      )}

      <Hint id="launches" className="px-1 pb-1">
        New mints and new pools on Solana, triaged as they arrive. <b>Nothing here is ranked or
        scored</b> — a token seconds old has no momentum to rank it by, so each row is a set of checks
        that either ran or did not, and the verdict says which. The best verdict available is{" "}
        <b>UNVERIFIED</b>: no check has failed, on a token far too young to have a record. There is no
        pass mark and no prediction of profit.{" "}
        <b>A solid ✓ is a reading; a hollow ○ only means nobody found anything</b>, which on a
        one-minute-old mint is usually a statement about how little has had time to happen.{" "}
        <b>LP lock and top-holder share read <i>n/a</i> on bonding-curve tokens</b> and that is not an
        omission — the curve holds the liquidity and the curve is the top holder, so graders return
        100% for every token at that stage regardless of quality. What can be judged before graduation
        is the deployer: how many mints they have issued, how many reached a pool, and how much of this
        one they still hold. Hover any glyph for the sentence behind it, or click a row to open all of
        them.{" "}
        <span className="dim">
          Mints and graduations both arrive within seconds, and the two lag figures above report them
          separately because they come down different pipes and averaging the two would hide both.
          <b> Curve</b> is how far a launchpad mint has climbed toward graduating; it reads{" "}
          <i>n/a</i> once there is no curve left and a dash when nobody published one.
        </span>
      </Hint>

      <div className="panel overflow-auto flex-1 min-h-0">
        <table className="w-full text-[12px] min-w-[1040px]">
          <thead className="thead sticky top-0 bg-[var(--panel-solid)] z-10">
            <tr>
              <th className="text-left px-3 py-2 font-medium w-[62px]">Age</th>
              <th className="text-left px-2 font-medium">Token</th>
              <th
                className="text-left px-2 font-medium w-[116px]"
                title={
                  "Every triage check, in order: creator history, creator rug history, mint authority, freeze authority, deployer allocation, LP lock, top-10 concentration, name collision, vendor flags.\n\n" +
                  "✓ solid = a direct reading   ○ hollow = nobody found anything   ! = warning   ✕ = failed   — = not checked   · = does not apply yet"
                }
              >
                Checks
              </th>
              <th className="text-left px-2 font-medium w-[128px]">Verdict</th>
              <th className="text-right px-2 font-medium">Liq</th>
              <th
                className="text-right px-2 font-medium"
                title="Market cap as the listing source publishes it. On a token minutes old it is what separates a curve nobody is buying from one people are."
              >
                MCap
              </th>
              <th
                className="text-right px-2 font-medium w-[74px]"
                title={
                  "How far along its bonding curve a launchpad mint has climbed, as the launchpad publishes it. " +
                  "A curve completing is a graduation, so this is the one column that says which rows are close.\n\n" +
                  "n/a once the curve is gone — a graduated token is in a real pool and has no curve to be a " +
                  "fraction of. A dash means nobody published a figure, which is most non-launchpad pools."
                }
              >
                Curve
              </th>
              <th className="text-right px-2 font-medium">Price</th>
              <th className="text-right px-2 font-medium" title="Holder count as published. On a token this young it is mostly a measure of age.">
                Holders
              </th>
              <th className="text-right px-2 font-medium" title="Buys and sells in the trailing 5 minutes.">
                B/S 5m
              </th>
              <th className="text-left px-2 font-medium">Origin</th>
              <th className="text-right px-3 font-medium" title="Milliseconds from this browser first seeing the row to its triage completing.">
                Triaged
              </th>
            </tr>
          </thead>
          <tbody className="num">
            {rows.map((l) => {
              const isNew = arrived.has(l.mint);
              const expanded = open === l.mint;
              return (
                <Fragment key={l.mint}>
                  <tr
                    className="trow cursor-pointer"
                    onClick={() => setOpen(expanded ? null : l.mint)}
                    style={isNew ? { background: "rgba(56,225,255,0.10)" } : undefined}
                  >
                    {/* Two different ages, never one column pretending to be
                        the other. A dated row's age runs from the creation
                        time its source published; an undated push row has
                        only its receipt, and the cell says which it is
                        showing rather than painting a receipt as a birth. */}
                    {l.poolCreatedAt === undefined ? (
                      <td
                        className="px-3 py-[6px] faint"
                        title={
                          `received ${new Date(l.firstSeenAt).toISOString()} by push (${l.source}), this machine's clock, uncorrected.\n` +
                          "dated by: not yet — the socket frame carries no creation time, and no polled source has listed this mint. " +
                          "This age counts from RECEIPT, so it can only understate the token's real age."
                        }
                      >
                        {ageLabel(now - l.firstSeenAt)}
                        <span className="chip chip-warn ml-1 text-[9px]">PUSH · undated</span>
                      </td>
                    ) : (
                      <td
                        className="px-3 py-[6px] faint"
                        title={
                          `pool created ${new Date(l.poolCreatedAt).toISOString()}` +
                          (l.datedBy && l.datedBy !== l.source ? ` (dated by ${l.datedBy})` : "") +
                          `\nfirst seen here ${new Date(l.firstSeenAt).toISOString()}` +
                          (l.source === "pumpportal-ws" ? " — by push" : "")
                        }
                      >
                        {ageLabel(now - l.poolCreatedAt)}
                        {l.event === "graduation" && <span className="chip chip-accent ml-1 text-[9px]">GRAD</span>}
                        {l.source === "pumpportal-ws" && (
                          <span className="chip ml-1 text-[9px]" title={sightingLine(l)}>
                            PUSH
                          </span>
                        )}
                      </td>
                    )}
                    <td className="px-2">
                      <Link
                        href={`/token?m=${l.mint}`}
                        // Not prefetched. Every other list in the app links rows
                        // the same way, but this one holds up to four hundred of
                        // them and churns the whole set every few minutes, so
                        // prefetching each row on scroll fires hundreds of
                        // requests for pages nobody will open — and in a static
                        // export there is no RSC payload at the other end
                        // anyway, so each one is a 404.
                        prefetch={false}
                        className="flex items-center gap-2 hover:text-[var(--accent)]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <TokenMark hue={l.hue} symbol={l.symbol || "??"} size={17} />
                        <span style={{ fontFamily: "var(--font-sans)" }}>
                          {/* A mint can reach the feed before its metadata does.
                              The address prefix is honest; a placeholder ticker
                              would not be. */}
                          {l.symbol || <span className="faint" title="the mint has no metadata yet">{l.mint.slice(0, 6)}…</span>}
                        </span>
                        {/* The one finding no per-token view can produce, because
                            the evidence is in the neighbours. Two mints with the
                            same name seconds apart is the impersonation play, and
                            each one alone looks unremarkable. */}
                        {l.twins && l.twins.length > 0 && (
                          <span
                            className="chip chip-warn text-[9px]"
                            title={`${l.twins.length} other mint${l.twins.length === 1 ? "" : "s"} in this feed launched under the same name or symbol:\n${l.twins.join("\n")}\n\nSometimes coincidence, sometimes a copy riding the original's search traffic.`}
                          >
                            ×{l.twins.length + 1} SAME NAME
                          </span>
                        )}
                      </Link>
                    </td>
                    <td className="px-2">
                      <CheckStrip launch={l} />
                    </td>
                    <td className="px-2">
                      <span className={`chip ${VERDICT_CLASS[l.triage.verdict]}`} title={triageHeadline(l.triage)}>
                        {l.triage.verdict}
                      </span>
                      <span className="faint text-[10px] ml-1.5" title={`${l.triage.measured} of ${l.triage.total} checks produced a measurement; ${l.triage.unchecked} could not run.`}>
                        {l.triage.measured}/{l.triage.total}
                      </span>
                    </td>
                    {/* An unpriced row is not a zero-liquidity row. Two of thirty
                        arrive before Jupiter has priced them, and those are the
                        freshest launches on the page. */}
                    <td className="text-right px-2 dim">
                      {l.liquidityUsd === undefined ? (
                        <span className="faint" title="the source has not priced this pool yet">—</span>
                      ) : (
                        fmtUsd(l.liquidityUsd)
                      )}
                    </td>
                    <td className="text-right px-2 dim">
                      {l.marketCapUsd === undefined ? (
                        <span className="faint" title="the source has not published a market cap for this mint yet">—</span>
                      ) : (
                        fmtUsd(l.marketCapUsd)
                      )}
                    </td>
                    {/* Three distinct states, and they must not collapse into
                        one. A graduated token HAS no curve (n/a); an unlisted
                        pool has one nobody published (dash); and 0% is a real
                        reading about a curve nobody has bought into. A default
                        of zero would render all three as the last one. */}
                    <td className="text-right px-2 text-[11px]">
                      {l.event === "graduation" ? (
                        <span className="faint" title="graduated — the curve is gone, this token is in a real pool">
                          n/a
                        </span>
                      ) : l.bondingCurvePct === undefined ? (
                        <span className="faint" title="no launchpad curve figure published for this mint">—</span>
                      ) : (
                        <span
                          className={l.bondingCurvePct >= 0.8 ? "pos" : l.bondingCurvePct >= 0.5 ? "warn" : "dim"}
                          title={`${(l.bondingCurvePct * 100).toFixed(1)}% of the way to graduating, as the launchpad publishes it.`}
                        >
                          {(l.bondingCurvePct * 100).toFixed(0)}%
                        </span>
                      )}
                    </td>
                    <td className="text-right px-2">
                      {l.priceUsd === undefined ? (
                        <span className="faint" title="the source has not priced this mint yet">—</span>
                      ) : (
                        fmtUsd(l.priceUsd)
                      )}
                    </td>
                    <td className="text-right px-2 dim">
                      {l.holders === undefined ? <span className="faint" title="not published">—</span> : fmtNum(l.holders)}
                    </td>
                    <td className="text-right px-2 text-[11px]">
                      {l.buys5m === undefined && l.sells5m === undefined ? (
                        <span className="faint" title="no trade counts published yet">—</span>
                      ) : (
                        <>
                          <span className="pos">{l.buys5m ?? 0}</span>
                          <span className="faint">/</span>
                          <span className="neg">{l.sells5m ?? 0}</span>
                        </>
                      )}
                    </td>
                    <OriginCell launch={l} />
                    <td className="text-right px-3 faint text-[10px]">
                      {l.triage.completedInMs === undefined ? (
                        <span title="the risk grade for this mint has not returned yet; its checks read as not-checked until it does">
                          pending
                        </span>
                      ) : (
                        `${l.triage.completedInMs}ms`
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={12} className="px-3 pb-3 pt-1">
                        <div className="text-[11px] flex flex-col gap-1">
                          <div className="dim pb-1">{triageHeadline(l.triage)}</div>
                          {l.triage.checks.map((c) => (
                            <div key={c.key} className="flex gap-2 items-start">
                              <span className={`${glyphOf(c).cls} w-[11px] text-center shrink-0`}>
                                {glyphOf(c).glyph}
                              </span>
                              <span className="w-[150px] shrink-0 dim" style={{ fontFamily: "var(--font-sans)" }}>
                                {c.name}
                                {c.assumed && (
                                  <span className="faint text-[9.5px]" title="this state came from a fail-safe default, not from a reading">
                                    {" "}
                                    assumed
                                  </span>
                                )}
                              </span>
                              <span className="faint" style={{ fontFamily: "var(--font-sans)" }}>
                                {c.detail}
                              </span>
                            </div>
                          ))}
                          <div className="faint pt-1.5 text-[10px]">
                            {l.mint} · {sightingLine(l)} · via {l.source}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <Empty>
            {!loaded
              ? "WATCHING SOLANA FOR NEW POOLS…"
              : error
                ? `feed unavailable — ${error}`
                : feed === null
                  ? // Never a simulated launch. See handleLaunches.
                    "No live launch source is configured, and this page does not simulate one. A synthetic launch feed would look identical to a real one while being fiction about the only thing it measures."
                  : "no launches match these filters"}
          </Empty>
        )}
      </div>
    </div>
  );
}
