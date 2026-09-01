"use client";

// The alert center, rebuilt around one uncomfortable fact: Nova has no
// server. Cielo evaluates its alerts in a datacenter around the clock;
// everything here evaluates in THIS browser, from the same rate-gated data
// paths the rest of the app polls, and stops when the browser stops running
// timers. The page's job is to make that boundary — and the coverage actually
// achieved inside it — visible on every rule, because an alert system that
// cannot say "nobody was watching between 14:02 and 14:31" will happily let
// silence impersonate an all-clear.
//
// The old page on this route was the demo-universe alert engine. It still
// exists, clearly labeled, folded to the bottom: synthetic rules firing on
// synthetic whales are a fine demonstration and a terrible thing to leave
// looking like the product.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useApi, apiPost, fmtAgo } from "@/lib/client";
import { Empty } from "@/components/ui/bits";
import {
  achievedCadenceMs,
  describeCondition,
  expectedCadenceMs,
  SOLANA_ADDRESS,
  WALLET_EVERY_MS,
  DETAIL_EVERY_MS,
  type LiveAlertCondition,
  type LiveAlertRule,
  type RuleEvalState,
} from "@/lib/alerts/rules";
import {
  addRule,
  alertsRaw,
  alertsRawServer,
  clearEvents,
  deleteRule,
  LOCK_STALE_MS,
  markAllRead,
  MAX_EVENTS,
  monitorStatus,
  monitorStatusServer,
  nextAlertId,
  parseAlerts,
  patchRule,
  setBackgroundWatch,
  subscribeAlerts,
  subscribeMonitor,
} from "@/lib/alerts/store";
import { notifyState, notifyStateServer, requestNotifyPermission, subscribeNotify } from "@/lib/alerts/notify";
import type { AlertEvent, AlertRule } from "@/lib/types";

/** Ticking clock so "evaluated 12s ago" counts without refetching. */
function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const secs = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`);

/**
 * The status a rule wears: evaluated recently, or NOT EVALUATED and why.
 *
 * "Not evaluated" is the load-bearing state. A rule whose source is down, or
 * whose tab spent an hour hidden, has said NOTHING about the world in that
 * window — and this chip is the difference between that and "no alert".
 */
export function ruleCoverage(
  rule: LiveAlertRule,
  state: RuleEvalState | undefined,
  now: number,
): { ok: boolean; label: string; detail: string } {
  if (!rule.enabled) return { ok: false, label: "OFF", detail: "rule disabled — nothing is evaluated" };
  const expected = expectedCadenceMs(rule.condition);
  if (!state?.lastAttemptAt) {
    return {
      ok: false,
      label: "NOT EVALUATED",
      detail: "no evaluation attempt yet — the monitor picks new rules up on its next pass",
    };
  }
  if (state.lastSkipReason) {
    return {
      ok: false,
      label: "NOT EVALUATED",
      detail: `${state.lastSkipReason} (last attempt ${fmtAgo(state.lastAttemptAt, now)})`,
    };
  }
  if (state.lastEvaluatedAt === undefined) {
    return { ok: false, label: "NOT EVALUATED", detail: "no pass has had usable data yet" };
  }
  const gap = now - state.lastEvaluatedAt;
  if (gap > Math.max(2.5 * expected, 45_000)) {
    return {
      ok: false,
      label: "NOT EVALUATED",
      detail:
        `last evaluated ${fmtAgo(state.lastEvaluatedAt, now)}; this rule aims at a pass every ~${secs(expected)}. ` +
        `The ${secs(gap)} since then is a coverage gap — anything that happened in it was not watched.`,
    };
  }
  return { ok: true, label: "WATCHING", detail: `last evaluated ${fmtAgo(state.lastEvaluatedAt, now)}` };
}

// ------------------------------------------------------------ rule builder

const KIND_LABEL: Record<LiveAlertCondition["kind"], string> = {
  launch: "New launch matches filters",
  graduation: "Watched token graduates",
  price_cross: "Token price crosses a level",
  liquidity_floor: "Token liquidity falls to a floor",
  signal_band: "Scanner token crosses a signal band",
  wallet_fills: "Watched wallet has new fills",
};

function RuleForm({ notifyGranted }: { notifyGranted: boolean }) {
  const [kind, setKind] = useState<LiveAlertCondition["kind"]>("launch");
  const [name, setName] = useState("");
  const [mint, setMint] = useState("");
  const [symbol, setSymbol] = useState("");
  const [wallet, setWallet] = useState("");
  const [launchpad, setLaunchpad] = useState("");
  const [minLiq, setMinLiq] = useState("");
  const [maxVerdict, setMaxVerdict] = useState("any");
  const [event, setEvent] = useState("any");
  const [direction, setDirection] = useState<"above" | "below">("above");
  const [threshold, setThreshold] = useState("");
  const [band, setBand] = useState("76");
  const [notify, setNotify] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  const create = () => {
    setProblem(null);
    let condition: LiveAlertCondition;
    const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
    if (kind === "launch") {
      condition = {
        kind,
        launchpad: launchpad.trim() || undefined,
        minLiquidityUsd: num(minLiq),
        maxVerdict: maxVerdict === "any" ? undefined : (maxVerdict as "unverified" | "caution"),
        event: event === "any" ? undefined : (event as "pool" | "graduation"),
      };
    } else if (kind === "graduation") {
      if (!SOLANA_ADDRESS.test(mint.trim())) return setProblem("that mint is not a Solana address (32-44 base58 characters)");
      condition = { kind, mint: mint.trim(), symbol: symbol.trim() || undefined };
    } else if (kind === "price_cross") {
      if (!SOLANA_ADDRESS.test(mint.trim())) return setProblem("that mint is not a Solana address (32-44 base58 characters)");
      const t = Number(threshold);
      if (!Number.isFinite(t) || t <= 0) return setProblem("the price threshold needs a positive number");
      condition = { kind, mint: mint.trim(), symbol: symbol.trim() || undefined, direction, thresholdUsd: t };
    } else if (kind === "liquidity_floor") {
      if (!SOLANA_ADDRESS.test(mint.trim())) return setProblem("that mint is not a Solana address (32-44 base58 characters)");
      const t = Number(threshold);
      if (!Number.isFinite(t) || t < 0) return setProblem("the liquidity floor needs a number (0 catches a drained pool)");
      condition = { kind, mint: mint.trim(), symbol: symbol.trim() || undefined, thresholdUsd: t };
    } else if (kind === "signal_band") {
      const b = Number(band);
      if (!Number.isFinite(b) || b < 1 || b > 100) return setProblem("the band is a score from 1 to 100");
      condition = { kind, band: Math.round(b) };
    } else {
      if (!SOLANA_ADDRESS.test(wallet.trim())) return setProblem("that wallet is not a Solana address (32-44 base58 characters)");
      condition = { kind, wallet: wallet.trim() };
    }
    const rule: LiveAlertRule = {
      id: nextAlertId("lar"),
      name: name.trim() || describeCondition(condition),
      condition,
      enabled: true,
      notify,
      createdAt: Date.now(),
    };
    addRule(rule);
    setName("");
    setMint("");
    setSymbol("");
    setWallet("");
    setThreshold("");
  };

  const mintField = (
    <label className="flex flex-col gap-1">
      <span className="panel-title">Mint</span>
      <input value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Solana mint address" className="input w-[300px] num" />
    </label>
  );
  const symbolField = (
    <label className="flex flex-col gap-1">
      <span className="panel-title">Symbol (label only)</span>
      <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="optional" className="input w-[90px]" />
    </label>
  );

  return (
    <div className="panel p-3 flex flex-col gap-2">
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1">
          <span className="panel-title">Alert type</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as LiveAlertCondition["kind"])} className="input">
            {Object.entries(KIND_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="panel-title">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" className="input w-[180px]" />
        </label>

        {kind === "launch" && (
          <>
            <label className="flex flex-col gap-1">
              <span className="panel-title">Launchpad / venue</span>
              <input
                value={launchpad}
                onChange={(e) => setLaunchpad(e.target.value)}
                placeholder="any — e.g. pump.fun"
                className="input w-[140px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="panel-title" title="A launch whose liquidity is not yet measured cannot match a liquidity filter — absence is not a small number.">
                Min liquidity $
              </span>
              <input value={minLiq} onChange={(e) => setMinLiq(e.target.value)} placeholder="any" className="input w-[100px] num" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="panel-title">Triage at worst</span>
              <select value={maxVerdict} onChange={(e) => setMaxVerdict(e.target.value)} className="input">
                <option value="any">any (incl. AVOID)</option>
                <option value="caution">CAUTION or better</option>
                <option value="unverified">UNVERIFIED only</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="panel-title">Event</span>
              <select value={event} onChange={(e) => setEvent(e.target.value)} className="input">
                <option value="any">pools + graduations</option>
                <option value="pool">new pools</option>
                <option value="graduation">graduations</option>
              </select>
            </label>
          </>
        )}

        {kind === "graduation" && (
          <>
            {mintField}
            {symbolField}
          </>
        )}
        {(kind === "price_cross" || kind === "liquidity_floor") && (
          <>
            {mintField}
            {symbolField}
            {kind === "price_cross" && (
              <label className="flex flex-col gap-1">
                <span className="panel-title">Direction</span>
                <select value={direction} onChange={(e) => setDirection(e.target.value as "above" | "below")} className="input">
                  <option value="above">above</option>
                  <option value="below">below</option>
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1">
              <span className="panel-title">{kind === "price_cross" ? "Price $" : "Floor $"}</span>
              <input value={threshold} onChange={(e) => setThreshold(e.target.value)} className="input w-[110px] num" />
            </label>
          </>
        )}
        {kind === "signal_band" && (
          <label className="flex flex-col gap-1">
            <span className="panel-title" title="Fires when a scored scanner token moves from below the band to at/above it between two scans. A token first seen already inside the band does not fire — one reading cannot claim a crossing.">
              Signal band ≥
            </span>
            <input value={band} onChange={(e) => setBand(e.target.value)} className="input w-[80px] num" />
          </label>
        )}
        {kind === "wallet_fills" && (
          <label className="flex flex-col gap-1">
            <span className="panel-title">Wallet</span>
            <input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="Solana wallet address" className="input w-[300px] num" />
          </label>
        )}

        <label className="flex items-center gap-1.5 pb-1.5 text-[11px] dim" title={notifyGranted ? "Also deliver through the system Notification API." : "System notifications are not enabled yet — this will only take effect after you enable them below."}>
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          system notification
        </label>
        <button className="btn btn-primary" onClick={create}>
          Create rule
        </button>
      </div>
      {problem && <div className="text-[11px] neg">{problem}</div>}
      <div className="hint">
        {kind === "wallet_fills" &&
          `A full wallet read is up to ~400 RPC calls, so watched wallets are re-read about every ${Math.round(WALLET_EVERY_MS / 60_000)} minutes — far slower than a fill lands. The alert tells you a fill happened; it does not race the block. The arming read sets the baseline: fills that predate the rule never fire.`}
        {(kind === "price_cross" || kind === "liquidity_floor") &&
          `Evaluated about every ${Math.round(DETAIL_EVERY_MS / 1000)}s per watched mint from the live token detail path. A crossing between two scans is reported with both readings; a condition already true when the rule is armed fires once and says the crossing moment was never observed.`}
        {kind === "signal_band" &&
          "Rides the scanner's own list (top trending mints, cached 30s). Only scored rows count — unscored rows carry a placeholder 0, not a score — and a crossing needs two observations of the same mint."}
        {(kind === "launch" || kind === "graduation") &&
          "Rides the launch feed's own rate-gated polls. Rows already in the feed when the rule is created never fire — a rule cannot catch an event that predates it. Pool-creation times are the source's claim, and each alert says so."}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- the page

export default function AlertsPage() {
  const now = useNow();
  const raw = useSyncExternalStore(subscribeAlerts, alertsRaw, alertsRawServer);
  const blob = useMemo(() => parseAlerts(raw), [raw]);
  const status = useSyncExternalStore(subscribeMonitor, monitorStatus, monitorStatusServer);
  // Through the external-store seam for the same reason the blob is: the
  // prerender has no Notification object, and the value changes exactly when
  // the permission prompt resolves.
  const notif = useSyncExternalStore(subscribeNotify, notifyState, notifyStateServer);
  const [showSim, setShowSim] = useState(false);

  const unread = blob.events.filter((e) => !e.read).length;
  const sources = Object.values(status.sources);
  const openGapNow = status.gaps.find((g) => g.to === undefined);
  const dropped = blob.dropped ?? {};
  const totalDropped = Object.values(dropped).reduce((a, b) => a + b, 0);
  const nameOf = (ruleId: string) => blob.rules.find((r) => r.id === ruleId)?.name ?? "a deleted rule";

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-[15px] font-semibold tracking-wide">ALERT CENTER</h1>
        {unread > 0 && (
          <span
            className="chip chip-accent"
            title={
              totalDropped > 0
                ? `${unread} unread of the alerts still held. The inbox keeps at most ${MAX_EVENTS}; ${totalDropped} older alert${totalDropped === 1 ? " has" : "s have"} been evicted, so this count is a floor, not a total.`
                : `${unread} unread`
            }
          >
            {unread}
            {totalDropped > 0 ? "+" : ""} unread
          </span>
        )}
        <span className="flex items-center gap-1.5 text-[10.5px] num dim">
          {/* Paused is checked FIRST. A paused tab releases its lease, so
              asking "am I the leader" before "am I even watching" let a tab
              that had just stood down announce that some other tab was
              covering for it — including, for up to 45s after a reload, a tab
              that was simply its own former self. */}
          {!status.running ? (
            <span className="faint">monitor starting…</span>
          ) : status.paused ? (
            <span className="warn" title="This tab is hidden and background watch is off, so nothing is being evaluated here. The lease has been released, so any visible Nova tab can take over immediately.">
              ■ paused — tab hidden
            </span>
          ) : !status.leader ? (
            // States what is actually KNOWN — that the lock is held — rather
            // than asserting that evaluation is happening somewhere. The two
            // are not the same, and after a reload the holder can briefly be
            // this tab's own ghost, monitoring nothing at all.
            <span
              className="warn"
              title={
                "Another Nova tab in this browser holds the evaluation lease, so this tab is not evaluating. " +
                `If that holder has stopped, its lease expires after ${Math.round(LOCK_STALE_MS / 1000)}s and this ` +
                "tab takes over on the next tick — briefly after a reload, the holder can be this tab's own " +
                "previous page. Whether rules are actually being evaluated is per-rule, below: anything not " +
                "evaluated says NOT EVALUATED."
              }
            >
              ◌ another tab holds the monitor lease
            </span>
          ) : status.visible ? (
            <>
              <span className="live-dot" /> monitoring in this tab
            </>
          ) : (
            <>
              <span className="live-dot" /> background watch (throttled by the browser)
            </>
          )}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn text-[11px]" onClick={markAllRead}>
            mark all read
          </button>
          <button className="btn text-[11px]" onClick={clearEvents} title="Deletes the fired-alert history. Rules and their watermarks stay.">
            clear inbox
          </button>
        </div>
      </div>

      {/* The boundary, stated where the rules live rather than in a footnote.
          This paragraph is the difference between this page and the products
          it is judged against. */}
      <div className="hint px-1">
        <b>These alerts run in your browser, not on a server.</b> Cielo and Photon evaluate rules in
        their datacenters around the clock; Nova has no backend, so rules are evaluated by this tab, from
        the same rate-gated live feeds the rest of the app polls, only while a Nova tab is open. Close the
        browser and nothing is watching — and rather than pretend otherwise, every rule below shows when
        it was last evaluated, the cadence it actually achieved, and any window nobody was watching. A
        rule that could not be evaluated says <b>NOT EVALUATED</b>, never &ldquo;no alert&rdquo;.
      </div>

      <div className="panel p-3 flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="panel-title">MONITOR</span>
          <label
            className="flex items-center gap-1.5 text-[11px] dim"
            title={
              "Keep evaluating while this tab is hidden. The rest of Nova deliberately stops polling in background tabs " +
              "to spare your battery; turning this on resumes alert passes at a slow cadence, and the browser still " +
              "throttles hidden tabs to roughly one pass a minute (harder after five minutes). The cadence shown per " +
              "rule is what was actually achieved, not this setting."
            }
          >
            <input type="checkbox" checked={blob.settings.backgroundWatch} onChange={(e) => setBackgroundWatch(e.target.checked)} />
            keep watching while this tab is in the background
          </label>
          <span className="text-[11px] dim flex items-center gap-2 ml-auto">
            {notif === "granted" && (
              <span className="chip chip-pos" title="System notifications are enabled. In the desktop shell they land in the Windows notification center.">
                system notifications on
              </span>
            )}
            {notif === "default" && (
              <button
                className="btn text-[11px]"
                onClick={() => void requestNotifyPermission()}
                title="Asks the browser for notification permission. Nova only ever asks from this button — never on page load."
              >
                enable system notifications
              </button>
            )}
            {notif === "denied" && (
              <span className="chip chip-warn" title="Notifications were blocked for this site. Only the browser's own site settings can undo that; Nova cannot re-prompt.">
                notifications blocked in browser settings
              </span>
            )}
            {notif === "unsupported" && <span className="chip">notifications unsupported here</span>}
          </span>
        </div>

        {sources.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] num">
            {sources.map((s) => (
              <span key={s.key} className={s.ok ? "dim" : "warn"} title={s.note ?? (s.dataAsOf ? `data as of ${fmtAgo(s.dataAsOf, now)}` : undefined)}>
                {s.ok ? "●" : "■"} {s.key}{" "}
                {s.ok
                  ? `ok ${s.lastSuccessAt ? fmtAgo(s.lastSuccessAt, now) : ""}`
                  : `failing${s.lastAttemptAt ? ` (${fmtAgo(s.lastAttemptAt, now)})` : ""}`}
              </span>
            ))}
          </div>
        )}

        {(status.gaps.length > 0 || openGapNow) && (
          <div className="text-[10.5px]">
            <span className="panel-title">coverage gaps this session</span>
            <div className="flex flex-col gap-0.5 mt-1">
              {status.gaps.slice(-5).map((g, i) => (
                <span key={i} className={g.to === undefined ? "warn num" : "faint num"}>
                  {new Date(g.from).toLocaleTimeString()} →{" "}
                  {g.to === undefined ? "now (open)" : new Date(g.to).toLocaleTimeString()} · {g.reason}
                </span>
              ))}
            </div>
          </div>
        )}
        {(status.notifDelivered > 0 || status.notifFailed > 0) && (
          <div className="text-[10px] faint num">
            system notifications this session: {status.notifDelivered} handed to the OS
            {status.notifFailed > 0 ? `, ${status.notifFailed} refused` : ""} — handed over is not proof one was seen; the
            inbox below is the record.
          </div>
        )}
      </div>

      <RuleForm notifyGranted={notif === "granted"} />

      <div className="grid grid-cols-1 xl:grid-cols-[440px_1fr] gap-3">
        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">Rules — live, evaluated in this browser</div>
          {blob.rules.map((r) => {
            const st = blob.states[r.id];
            const cov = ruleCoverage(r, st, now);
            const cadence = st ? achievedCadenceMs(st) : null;
            return (
              <div key={r.id} className="px-3 py-2 border-b border-[rgba(27,35,51,0.5)] flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] truncate">{r.name}</div>
                  <div className="text-[10.5px] faint">{describeCondition(r.condition)}</div>
                  <div className="text-[10px] num mt-0.5 flex items-center gap-2 flex-wrap">
                    <span className={`chip ${cov.ok ? "chip-pos" : r.enabled ? "chip-warn" : ""}`} title={cov.detail}>
                      {cov.label}
                    </span>
                    <span className="faint" title={cov.detail}>
                      {st?.lastEvaluatedAt ? `evaluated ${fmtAgo(st.lastEvaluatedAt, now)}` : "never evaluated"}
                    </span>
                    <span
                      className="faint"
                      title={
                        cadence !== null
                          ? `Median gap between this rule's recent successful evaluations — the cadence actually achieved, which browser throttling and source failures both show up in. Target: ~${secs(expectedCadenceMs(r.condition))}.`
                          : "Achieved cadence appears after three successful evaluations."
                      }
                    >
                      cadence {cadence !== null ? `~${secs(cadence)}` : "—"} (target ~{secs(expectedCadenceMs(r.condition))})
                    </span>
                    {st?.armedAt && (
                      <span className="faint" title="First successful evaluation. Events that predate arming never fire.">
                        armed {fmtAgo(st.armedAt, now)}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  className={`chip cursor-pointer ${r.notify ? "chip-accent" : ""}`}
                  title={r.notify ? "System notification on fire (needs permission above)." : "Inbox only."}
                  onClick={() => patchRule(r.id, { notify: !r.notify })}
                >
                  {r.notify ? "sys" : "inbox"}
                </button>
                <button className={`chip cursor-pointer ${r.enabled ? "chip-pos" : ""}`} onClick={() => patchRule(r.id, { enabled: !r.enabled })}>
                  {r.enabled ? "on" : "off"}
                </button>
                <button className="chip chip-neg cursor-pointer" onClick={() => deleteRule(r.id)}>
                  ✕
                </button>
              </div>
            );
          })}
          {blob.rules.length === 0 && (
            <Empty>
              No live rules yet. Create one above — it starts evaluating on the monitor&apos;s next pass and says so.
            </Empty>
          )}
        </div>

        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1 flex items-baseline gap-2">
            <span>Fired — live</span>
            <span className="faint text-[10px] normal-case tracking-normal">
              every entry records the measurement that tripped it and when it was evaluated; on-chain times appear only
              when a source actually claimed one
            </span>
          </div>
          {/* The inbox says it is the record, so it has to own its own limit.
              It used to evict oldest-first and silently, which meant a busy
              launch rule could erase every other rule's history inside a few
              minutes — a verified price-crossing alert vanished that way. What
              was taken is now counted per rule and printed. */}
          {totalDropped > 0 && (
            <div className="px-3 py-1.5 border-b border-[rgba(27,35,51,0.5)] text-[10.5px] warn">
              History truncated: {totalDropped} older alert{totalDropped === 1 ? "" : "s"} dropped to stay inside the{" "}
              {MAX_EVENTS}-alert inbox —{" "}
              {Object.entries(dropped)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([ruleId, n]) => `${n} from "${nameOf(ruleId)}"`)
                .join(", ")}
              . Eviction takes from whichever rule holds the most, so a noisy rule cannot delete a quiet one&apos;s
              record.
            </div>
          )}
          <div className="max-h-[560px] overflow-y-auto">
            {blob.events.map((e) => (
              <Link
                key={e.id}
                href={e.mint ? `/token?m=${e.mint}` : e.wallet ? `/whale?a=${e.wallet}` : "#"}
                className={`block px-3 py-2 border-b border-[rgba(27,35,51,0.5)] hover:bg-[rgba(40,55,85,0.15)] ${e.read ? "opacity-55" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold tracking-wide text-[var(--accent)] truncate">{e.headline}</span>
                  <span className="num text-[10px] faint shrink-0" title={`evaluated at ${new Date(e.firedAt).toISOString()}`}>
                    {fmtAgo(e.firedAt, now)}
                  </span>
                </div>
                <div className="text-[11.5px] dim mt-0.5">{e.measurement}</div>
                {e.gapNote && <div className="text-[10.5px] warn mt-0.5">{e.gapNote}</div>}
                <div className="text-[10px] faint num mt-0.5 flex gap-3 flex-wrap">
                  <span title="When this tab's evaluator produced the alert — its own clock.">evaluated {fmtAgo(e.firedAt, now)}</span>
                  <span title="The timestamp the data payload claims for itself.">data as of {fmtAgo(e.dataAsOf, now)}</span>
                  {e.eventAt !== undefined ? (
                    <span title={e.eventAtNote ?? "as claimed by the source"}>event {fmtAgo(e.eventAt, now)} ({e.eventAtNote?.split(" — ")[0] ?? "source claim"})</span>
                  ) : (
                    <span title="No source published an on-chain moment for this — the evaluation time above is all that is honestly known.">
                      on-chain time: not known
                    </span>
                  )}
                </div>
              </Link>
            ))}
            {blob.events.length === 0 && (
              <Empty>
                Nothing fired yet. Rules marked WATCHING are being evaluated; this stays empty until a measurement
                actually trips one — there are no example alerts here.
              </Empty>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------ simulated engine */}
      <div className="panel p-3">
        <button className="flex items-center gap-2 text-left w-full" onClick={() => setShowSim((s) => !s)}>
          <span className="panel-title">SIMULATED ALERT ENGINE (DEMO UNIVERSE)</span>
          <span className="chip" title="Everything inside evaluates against the deterministic demo universe. The wallets and tokens in it do not exist on Solana.">
            SIMULATED
          </span>
          <span className="faint text-[11px] ml-auto">{showSim ? "hide" : "show"}</span>
        </button>
        {showSim && <SimAlerts nowMs={now} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------- demo-engine panel
//
// The pre-existing demo alert engine, unchanged underneath: rules stored in
// the demo store, matched by the simulator against synthetic whale trades and
// synthetic signals. Kept because it demonstrates the alert lifecycle without
// waiting for a real threshold to trip — and labeled within an inch of its
// life because that is the only condition under which fake firings are
// tolerable in this app.

function SimAlerts({ nowMs }: { nowMs: number }) {
  const { data, reload } = useApi<{ rules: AlertRule[]; events: AlertEvent[] }>("/api/alerts", 8000);
  const [type, setType] = useState("whale_buy");
  const [threshold, setThreshold] = useState("50000");

  const post = async (body: unknown) => {
    await apiPost("/api/alerts", body);
    reload();
  };
  const create = () => {
    const t = Number(threshold) || 0;
    const condition =
      type === "whale_buy" || type === "whale_sell"
        ? { type, minUsd: t }
        : type === "signal_score_above"
          ? { type, threshold: Math.min(100, t) }
          : { type: "volume_spike", multiple: Math.max(1, t) };
    post({ op: "create", name: `[sim] ${type.replace(/_/g, " ")} ≥ ${threshold}`, condition });
  };

  return (
    <div className="flex flex-col gap-2 mt-2">
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1">
          <span className="panel-title">Condition</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className="input">
            <option value="whale_buy">Whale buy ≥ $</option>
            <option value="whale_sell">Whale sell ≥ $</option>
            <option value="signal_score_above">Signal score ≥</option>
            <option value="volume_spike">Volume spike ×</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="panel-title">Threshold</span>
          <input value={threshold} onChange={(e) => setThreshold(e.target.value)} className="input w-[110px] num" />
        </label>
        <button className="btn" onClick={create}>
          Create simulated rule
        </button>
        <button className="btn text-[11px]" onClick={() => post({ op: "mark_read" })}>
          mark read
        </button>
        <span className="faint text-[10.5px] pb-1.5">
          fires on synthetic events from the demo universe — useful for seeing the lifecycle, meaningless as a market fact
        </span>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div>
          {(data?.rules ?? []).map((r) => (
            <div key={r.id} className="px-1 py-1.5 border-b border-[rgba(27,35,51,0.5)] flex items-center gap-2">
              <span className="chip shrink-0">SIM</span>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] truncate">{r.name}</div>
                <div className="text-[10px] faint num">{JSON.stringify(r.condition)}</div>
              </div>
              <button className={`chip cursor-pointer ${r.enabled ? "chip-pos" : ""}`} onClick={() => post({ op: "toggle", id: r.id })}>
                {r.enabled ? "on" : "off"}
              </button>
              <button className="chip chip-neg cursor-pointer" onClick={() => post({ op: "delete", id: r.id })}>
                ✕
              </button>
            </div>
          ))}
          {(data?.rules ?? []).length === 0 && <Empty>No simulated rules.</Empty>}
        </div>
        <div className="max-h-[300px] overflow-y-auto">
          {(data?.events ?? []).map((e) => (
            <div key={e.id} className={`px-1 py-1.5 border-b border-[rgba(27,35,51,0.5)] ${e.read ? "opacity-55" : ""}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold tracking-wide dim truncate">
                  <span className="chip mr-1.5">SIM</span>
                  {e.headline}
                </span>
                <span className="num text-[10px] faint shrink-0">{fmtAgo(e.ts, nowMs)}</span>
              </div>
              <div className="text-[11px] faint mt-0.5">{e.detail}</div>
            </div>
          ))}
          {(data?.events ?? []).length === 0 && <Empty>Nothing fired in the simulation.</Empty>}
        </div>
      </div>
    </div>
  );
}
