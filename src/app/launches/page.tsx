"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiGet, fmtUsd, fmtNum } from "@/lib/client";
import { TokenMark, Empty } from "@/components/ui/bits";
import { triageHeadline } from "@/lib/engine/triage";
import type { LaunchFeed } from "@/lib/api/launches";
import type { LaunchCheck, TokenLaunch } from "@/lib/types";

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

const CHECK_GLYPH: Record<LaunchCheck["state"], string> = {
  pass: "✓",
  warn: "!",
  fail: "✕",
  unchecked: "—",
  "n/a": "·",
};

const CHECK_CLASS: Record<LaunchCheck["state"], string> = {
  pass: "pos",
  warn: "warn",
  fail: "neg",
  unchecked: "faint",
  "n/a": "faint",
};

/**
 * The eight checks as eight glyphs.
 *
 * A dash and a tick have to be distinguishable at a glance, because the whole
 * point is that "nobody looked" and "looked and it is fine" are different
 * answers. Hovering any glyph gives the sentence behind it.
 */
function CheckStrip({ launch }: { launch: TokenLaunch }) {
  return (
    <span className="inline-flex gap-[3px] items-center">
      {launch.triage.checks.map((c) => (
        <span
          key={c.key}
          className={`${CHECK_CLASS[c.state]} text-[11px] leading-none w-[11px] text-center`}
          title={`${c.name}: ${c.state.toUpperCase()}${c.assumed ? " (assumed, not measured)" : ""}\n${c.detail}`}
        >
          {CHECK_GLYPH[c.state]}
        </span>
      ))}
    </span>
  );
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
    const start = () => {
      if (timer !== undefined) return;
      timer = setInterval(load, POLL_MS);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
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
      document.removeEventListener("visibilitychange", onVisibility);
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [paused]);

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
      if (venue !== "all" && (l.launchpad ?? l.venue) !== venue) return false;
      return true;
    });
  }, [feed, minLiq, hideSerial, hideAvoid, venue]);

  const lag = feed?.lagP50Ms;
  const skewed = feed?.lagMinMs !== null && feed?.lagMinMs !== undefined && feed.lagMinMs < 0;

  return (
    <div className="p-3 flex flex-col gap-2 h-full min-h-0">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-[15px] font-semibold tracking-wide">LAUNCH FEED</h1>
        {feed && (
          <span
            className="flex items-center gap-1.5 text-[10.5px] dim num ml-2"
            title="Pools created in the last 60 seconds, counted from the feed's own rows. Not a rate extrapolated from how long this tab has been open."
          >
            <span className="live-dot" />
            {feed.perMinute}/min · +{feed.addedLastPass} last pass
          </span>
        )}
        {feed && (
          <span
            className="text-[10.5px] num dim"
            title={
              "Median of (when this tab first saw the row) minus (the pool creation time the source published).\n\n" +
              `From ${feed.lagSamples} launch${feed.lagSamples === 1 ? "" : "es"} that happened AFTER this feed opened. ` +
              "The rows already on screen when you arrived were backfilled from the source's existing page, so their " +
              "apparent age says when you opened the tab, not how fast the feed is — they are excluded here and shown " +
              "in the list anyway.\n\n" +
              `p90 ${feed.lagP90Ms === null ? "—" : `${(feed.lagP90Ms / 1000).toFixed(1)}s`} · ` +
              `min ${feed.lagMinMs === null ? "—" : `${(feed.lagMinMs / 1000).toFixed(1)}s`}\n\n` +
              "Includes any difference between the source's clock and yours. A negative minimum means your clock " +
              "is ahead of theirs, not that the feed saw the future." +
              (feed.windowSeconds !== null
                ? `\n\nThe last listing page spanned ${feed.windowSeconds.toFixed(0)}s of Solana. That endpoint caps ` +
                  `at 30 rows with no cursor, so if the span ever falls near the ${POLL_MS / 1000}s poll interval, ` +
                  "launches are dropping off the back unseen."
                : "")
            }
          >
            feed lag{" "}
            {feed.lagSamples === 0 ? (
              <span className="faint" title="no launch has arrived since this feed opened yet">
                measuring…
              </span>
            ) : (
              <>
                {lag === null || lag === undefined ? "—" : `${(lag / 1000).toFixed(1)}s`}
                <span className="faint"> n={feed.lagSamples}</span>
                {skewed ? " *" : ""}
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
          <button className={`btn text-[11px] ${paused ? "btn-danger" : ""}`} onClick={() => setPaused((x) => !x)}>
            {paused ? "▶ resume" : "⏸ pause"}
          </button>
        </div>
      </div>

      <div className="hint px-1 pb-1">
        Every new mint and pool on Solana, triaged the moment it appears. <b>Nothing here is ranked or
        scored</b> — a token seconds old has no momentum to rank it by, so each row is a set of checks
        that either ran or did not, and the verdict says which. The best verdict available is{" "}
        <b>UNVERIFIED</b>: no check has failed, on a token far too young to have a record. There is no
        pass mark and no prediction of profit.{" "}
        <b>LP lock and top-holder share read <i>n/a</i> on bonding-curve tokens</b> and that is not an
        omission — the curve holds the liquidity and the curve is the top holder, so graders return
        100% for every token at that stage regardless of quality. What can be judged before graduation
        is the deployer: how many mints they have issued, how many reached a pool, and how much of this
        one they still hold. Hover any glyph for the sentence behind it, or click a row to open all of
        them.
      </div>

      <div className="panel overflow-auto flex-1 min-h-0">
        <table className="w-full text-[12px] min-w-[1040px]">
          <thead className="thead sticky top-0 bg-[var(--panel-solid)] z-10">
            <tr>
              <th className="text-left px-3 py-2 font-medium w-[62px]">Age</th>
              <th className="text-left px-2 font-medium">Token</th>
              <th className="text-left px-2 font-medium w-[104px]" title="Every triage check, in order: creator history, creator rug history, mint authority, freeze authority, deployer allocation, LP lock, top-10 concentration, vendor flags.">
                Checks
              </th>
              <th className="text-left px-2 font-medium w-[128px]">Verdict</th>
              <th className="text-right px-2 font-medium">Liq</th>
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
                    <td className="px-3 py-[6px] faint" title={`pool created ${new Date(l.poolCreatedAt).toISOString()}\nfirst seen here ${new Date(l.firstSeenAt).toISOString()}`}>
                      {ageLabel(now - l.poolCreatedAt)}
                      {l.event === "graduation" && <span className="chip chip-accent ml-1 text-[9px]">GRAD</span>}
                    </td>
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
                      <td colSpan={10} className="px-3 pb-3 pt-1">
                        <div className="text-[11px] flex flex-col gap-1">
                          <div className="dim pb-1">{triageHeadline(l.triage)}</div>
                          {l.triage.checks.map((c) => (
                            <div key={c.key} className="flex gap-2 items-start">
                              <span className={`${CHECK_CLASS[c.state]} w-[11px] text-center shrink-0`}>
                                {CHECK_GLYPH[c.state]}
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
                            {l.mint} · seen {((l.firstSeenAt - l.poolCreatedAt) / 1000).toFixed(1)}s after the source&rsquo;s
                            pool-creation time · via {l.source}
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
