"use client";

// The live alert monitor: one loop per BROWSER (not per tab — see the lease),
// mounted in the shell so it runs whichever page is open.
//
// WHAT THIS DELIBERATELY IS NOT
//
// Cielo's alerts run on Cielo's servers, around the clock, whether the user's
// laptop is open or not. Nova has no server: everything here executes in this
// tab, against the same rate-gated data paths the pages themselves use, and
// stops when the browser stops running timers. That boundary is stated on the
// alerts page rather than papered over, and the machinery below spends most
// of its lines measuring the coverage actually achieved so the page can print
// that instead of a promise.
//
// WHY THIS CREATES ALMOST NO NEW PROVIDER TRAFFIC
//
// Every fetch below lands on a module that already rate-gates itself for the
// pages' benefit: the token list is cached 30s with in-flight dedup, the
// launch feed refuses to poll its vendors faster than its measured ceilings
// (3s/3s/6s) no matter how often it is asked, token detail is cached 20s, and
// a wallet profile 45s. With the scanner or launch page open, the monitor's
// requests are answered from those caches; alone on some other page, it costs
// about what one additional open page costs — and the per-source cadences here
// are set at or below the pages' own poll rates.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/client";
import type { LaunchFeed } from "@/lib/api/launches";
import type { TokenRow } from "@/lib/api/rows";
import type { WalletProfile } from "@/lib/types";
import {
  DETAIL_EVERY_MS,
  LAUNCHES_EVERY_MS,
  SCANNER_EVERY_MS,
  TICK_HIDDEN_MS,
  TICK_VISIBLE_MS,
  WALLET_EVERY_MS,
  evaluateGraduationRule,
  evaluateLaunchRule,
  evaluateLiquidityRule,
  evaluatePriceRule,
  evaluateSignalBandRule,
  evaluateWalletRule,
  markSkipped,
  type EvalResult,
  type LiveAlertEvent,
  type LiveAlertRule,
  type RuleEvalState,
} from "@/lib/alerts/rules";
import {
  acquireLease,
  applyEvaluation,
  closeGap,
  loadAlerts,
  nextAlertId,
  noteNotification,
  noteSourcePass,
  openGap,
  releaseLease,
  updateMonitorStatus,
} from "@/lib/alerts/store";
import { deliverNotification } from "@/lib/alerts/notify";

interface DetailResp {
  snapshot?: { priceUsd: number; liquidityUsd: number; ts?: number; unmeasured?: readonly string[] };
  source?: string;
  asOf?: number;
  demo: boolean;
}

interface ProfileResp {
  profile: WalletProfile;
  demo: boolean;
}

function stateFor(states: Record<string, RuleEvalState>, rule: LiveAlertRule): RuleEvalState {
  return states[rule.id] ?? { ruleId: rule.id };
}

/** Fold one pass's results into id-keyed states + concrete events. */
function fold(results: EvalResult[]): { states: Record<string, RuleEvalState>; events: LiveAlertEvent[] } {
  const states: Record<string, RuleEvalState> = {};
  const events: LiveAlertEvent[] = [];
  for (const r of results) {
    states[r.state.ruleId] = r.state;
    for (const f of r.fires) events.push({ ...f, id: nextAlertId("lae"), read: false });
  }
  return { states, events };
}

export function AlertMonitor() {
  const [toasts, setToasts] = useState<LiveAlertEvent[]>([]);
  const lastAttempt = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // Local to the effect: the id exists to distinguish tabs racing for the
    // lease, and everything that uses it lives in this closure.
    const tabId = `tab-${Math.random().toString(36).slice(2, 10)}`;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const toastTimers: ReturnType<typeof setTimeout>[] = [];

    const pushToasts = (events: LiveAlertEvent[]) => {
      if (events.length === 0) return;
      setToasts((ts) => [...ts, ...events].slice(-3));
      const t = setTimeout(() => {
        if (!dead) setToasts((ts) => ts.filter((x) => !events.some((e) => e.id === x.id)));
      }, 9000);
      toastTimers.push(t);
    };

    const dispatch = (rules: LiveAlertRule[], results: EvalResult[]) => {
      const { states, events } = fold(results);
      if (Object.keys(states).length === 0 && events.length === 0) return;
      applyEvaluation(states, events);
      const notifiable = new Set(rules.filter((r) => r.notify).map((r) => r.id));
      for (const e of events) {
        if (notifiable.has(e.ruleId)) noteNotification(deliverNotification(e));
      }
      pushToasts(events);
    };

    const skipAll = (rules: LiveAlertRule[], states: Record<string, RuleEvalState>, now: number, reason: string) => {
      dispatch(
        rules,
        rules.map((r) => ({ state: markSkipped(stateFor(states, r), now, reason), fires: [] })),
      );
    };

    const due = (key: string, everyMs: number, now: number) => now - (lastAttempt.current.get(key) ?? 0) >= everyMs;

    // ---------------------------------------------------------- source passes

    const passScanner = async (rules: LiveAlertRule[], states: Record<string, RuleEvalState>, now: number) => {
      lastAttempt.current.set("scanner", now);
      try {
        const body = await apiGet<{ rows: TokenRow[]; demo: boolean; asOf: number; provenance?: { source?: string } }>(
          "/api/tokens?limit=300",
        );
        if (body.demo) {
          // The simulator answering is a fact about our sources, not about any
          // token, and live rules never evaluate on simulated data.
          const why = "live token source unavailable — the simulator answered this pass, and live rules never read simulated data";
          noteSourcePass({ key: "scanner", lastAttemptAt: now, ok: false, note: why });
          skipAll(rules, states, now, why);
          return;
        }
        noteSourcePass({ key: "scanner", lastAttemptAt: now, lastSuccessAt: now, dataAsOf: body.asOf, ok: true });
        dispatch(
          rules,
          rules.map((r) =>
            evaluateSignalBandRule(
              r,
              stateFor(states, r),
              body.rows.map((row) => ({
                mint: row.mint,
                symbol: row.symbol,
                signalScore: row.signalScore,
                scored: row.scored !== false,
                dataTs: row.dataTs,
              })),
              body.asOf,
              now,
            ),
          ),
        );
      } catch (err) {
        const why = `scanner list unreachable — ${err instanceof Error ? err.message : String(err)}`;
        noteSourcePass({ key: "scanner", lastAttemptAt: now, ok: false, note: why });
        skipAll(rules, states, now, why);
      }
    };

    const passLaunches = async (rules: LiveAlertRule[], states: Record<string, RuleEvalState>, now: number) => {
      lastAttempt.current.set("launches", now);
      try {
        const body = await apiGet<{ feed: LaunchFeed | null }>("/api/launches");
        if (!body.feed) {
          const why = "no live launch source configured — the launch feed refuses to simulate, and so does this rule";
          noteSourcePass({ key: "launches", lastAttemptAt: now, ok: false, note: why });
          skipAll(rules, states, now, why);
          return;
        }
        const feed = body.feed;
        if (feed.stale || feed.lastSuccessAt === 0) {
          // Rows are still on screen, but nothing new can arrive through a
          // dead poll. Evaluating them would stamp "evaluated" on a window
          // this tab was actually blind in.
          const why =
            `launch feed stale — no successful poll for ${Math.round((now - feed.lastSuccessAt) / 1000)}s` +
            (feed.lastError ? ` (${feed.lastError})` : "");
          noteSourcePass({ key: "launches", lastAttemptAt: now, lastSuccessAt: feed.lastSuccessAt || undefined, ok: false, note: why });
          skipAll(rules, states, now, why);
          return;
        }
        noteSourcePass({ key: "launches", lastAttemptAt: now, lastSuccessAt: now, dataAsOf: feed.lastSuccessAt, ok: true });
        const obs = { rows: feed.launches, dataAsOf: feed.lastSuccessAt, sourceName: feed.provenance.source };
        dispatch(
          rules,
          rules.map((r) =>
            r.condition.kind === "graduation"
              ? evaluateGraduationRule(r, stateFor(states, r), obs, now)
              : evaluateLaunchRule(r, stateFor(states, r), obs, now),
          ),
        );
      } catch (err) {
        const why = `launch feed unreachable — ${err instanceof Error ? err.message : String(err)}`;
        noteSourcePass({ key: "launches", lastAttemptAt: now, ok: false, note: why });
        skipAll(rules, states, now, why);
      }
    };

    const passDetail = async (mint: string, rules: LiveAlertRule[], states: Record<string, RuleEvalState>, now: number) => {
      const key = `detail:${mint}`;
      lastAttempt.current.set(key, now);
      try {
        const body = await apiGet<DetailResp>(`/api/tokens/${mint}`);
        if (body.demo || !body.snapshot) {
          const why = "live token detail unavailable — the simulator answered, and live rules never read simulated data";
          noteSourcePass({ key, lastAttemptAt: now, ok: false, note: why });
          skipAll(rules, states, now, why);
          return;
        }
        const dataAsOf = body.snapshot.ts ?? body.asOf ?? now;
        noteSourcePass({ key, lastAttemptAt: now, lastSuccessAt: now, dataAsOf, ok: true });
        const obs = {
          priceUsd: body.snapshot.priceUsd,
          liquidityUsd: body.snapshot.liquidityUsd,
          unmeasured: body.snapshot.unmeasured,
          dataAsOf,
          sourceName: body.source ?? "live",
        };
        dispatch(
          rules,
          rules.map((r) =>
            r.condition.kind === "price_cross"
              ? evaluatePriceRule(r, stateFor(states, r), obs, now)
              : evaluateLiquidityRule(r, stateFor(states, r), obs, now),
          ),
        );
      } catch (err) {
        const why = `token detail unreachable — ${err instanceof Error ? err.message : String(err)}`;
        noteSourcePass({ key, lastAttemptAt: now, ok: false, note: why });
        skipAll(rules, states, now, why);
      }
    };

    const passWallet = async (wallet: string, rules: LiveAlertRule[], states: Record<string, RuleEvalState>, now: number) => {
      const key = `wallet:${wallet}`;
      lastAttempt.current.set(key, now);
      try {
        const body = await apiGet<ProfileResp>(`/api/wallets/${wallet}/profile`);
        const p = body.profile;
        noteSourcePass({ key, lastAttemptAt: now, lastSuccessAt: now, dataAsOf: p.coverage.newestTs || undefined, ok: true });
        dispatch(
          rules,
          rules.map((r) =>
            evaluateWalletRule(
              r,
              stateFor(states, r),
              {
                fills: p.fills.map((f) => ({
                  signature: f.signature,
                  ts: f.ts,
                  mint: f.mint,
                  side: f.side,
                  tokens: f.tokens,
                  valueUsd: f.valueUsd,
                  unpricedReason: f.unpricedReason,
                })),
                newestTs: p.coverage.newestTs,
                windowHours: p.coverage.windowHours,
                // The read finished now, possibly from the profile seam's 45s
                // cache; the fills' own block times carry the on-chain moment.
                dataAsOf: now,
                sourceName: p.coverage.source,
              },
              now,
            ),
          ),
        );
      } catch (err) {
        const why = `wallet read failed — ${err instanceof Error ? err.message : String(err)}`;
        noteSourcePass({ key, lastAttemptAt: now, ok: false, note: why });
        skipAll(rules, states, now, why);
      }
    };

    // ------------------------------------------------------------------ tick

    const tick = async () => {
      if (dead) return;
      const now = Date.now();
      const visible = typeof document === "undefined" || document.visibilityState === "visible";
      const { rules, states, settings } = loadAlerts();
      const enabled = rules.filter((r) => r.enabled);

      // One evaluating tab per browser profile. The lease is a heartbeat in
      // localStorage; a crashed leader goes stale in 45s and any tab takes
      // over on its next tick.
      const leader = acquireLease(tabId, now);
      updateMonitorStatus({
        running: true,
        leader,
        visible,
        backgroundWatch: settings.backgroundWatch,
        lastTickAt: now,
      });

      const paused = !visible && !settings.backgroundWatch;
      if (paused) openGap(now, "tab hidden — monitoring paused (background watch is off)");
      else closeGap(now);

      if (leader && !paused && enabled.length > 0) {
        const jobs: Promise<void>[] = [];

        const scannerRules = enabled.filter((r) => r.condition.kind === "signal_band");
        if (scannerRules.length > 0 && due("scanner", SCANNER_EVERY_MS, now)) {
          jobs.push(passScanner(scannerRules, states, now));
        }

        const launchRules = enabled.filter((r) => r.condition.kind === "launch" || r.condition.kind === "graduation");
        if (launchRules.length > 0 && due("launches", LAUNCHES_EVERY_MS, now)) {
          jobs.push(passLaunches(launchRules, states, now));
        }

        // Detail and wallet reads rotate: most-stale first, a bounded number
        // per tick, so twenty token rules degrade to a slower measured cadence
        // instead of a request burst. The page prints the achieved cadence,
        // which is where that degradation becomes visible instead of secret.
        const byMint = new Map<string, LiveAlertRule[]>();
        for (const r of enabled) {
          if (r.condition.kind === "price_cross" || r.condition.kind === "liquidity_floor") {
            const list = byMint.get(r.condition.mint) ?? [];
            list.push(r);
            byMint.set(r.condition.mint, list);
          }
        }
        const dueMints = [...byMint.keys()]
          .filter((m) => due(`detail:${m}`, DETAIL_EVERY_MS, now))
          .sort((a, b) => (lastAttempt.current.get(`detail:${a}`) ?? 0) - (lastAttempt.current.get(`detail:${b}`) ?? 0))
          .slice(0, 2);
        for (const m of dueMints) jobs.push(passDetail(m, byMint.get(m)!, states, now));

        const byWallet = new Map<string, LiveAlertRule[]>();
        for (const r of enabled) {
          if (r.condition.kind === "wallet_fills") {
            const list = byWallet.get(r.condition.wallet) ?? [];
            list.push(r);
            byWallet.set(r.condition.wallet, list);
          }
        }
        const dueWallets = [...byWallet.keys()]
          .filter((w) => due(`wallet:${w}`, WALLET_EVERY_MS, now))
          .sort((a, b) => (lastAttempt.current.get(`wallet:${a}`) ?? 0) - (lastAttempt.current.get(`wallet:${b}`) ?? 0))
          .slice(0, 1);
        for (const w of dueWallets) jobs.push(passWallet(w, byWallet.get(w)!, states, now));

        await Promise.all(jobs);
      }

      if (dead) return;
      // A chain of timeouts rather than an interval: a hidden tab's next tick
      // may be stretched arbitrarily by the browser's throttling, and chaining
      // means the achieved cadence is measured instead of queued up.
      timer = setTimeout(tick, paused ? TICK_VISIBLE_MS : visible ? TICK_VISIBLE_MS : TICK_HIDDEN_MS);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Straight back to work, and the reopened gap (if any) closes with a
        // real end time on this tick.
        if (timer) clearTimeout(timer);
        void tick();
      }
    };

    void tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
      for (const t of toastTimers) clearTimeout(t);
      document.removeEventListener("visibilitychange", onVisibility);
      releaseLease(tabId);
      updateMonitorStatus({ running: false, leader: false });
    };
    // Mounted once for the life of the shell; everything it needs it reads
    // fresh each tick, so there is nothing to re-run this effect for.
  }, []);

  // Bottom-LEFT so the simulator's toasts (bottom-right, labeled SIMULATED)
  // and these can never be visually conflated.
  return (
    <div className="fixed bottom-4 left-4 z-40 flex flex-col gap-2 w-[340px] pointer-events-none">
      {toasts.map((t) => (
        <Link
          key={t.id}
          href={t.mint ? `/token?m=${t.mint}` : t.wallet ? `/whale?a=${t.wallet}` : "/alerts"}
          className="toast panel p-3 pointer-events-auto block hover:border-[var(--accent)]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] tracking-[0.14em] font-semibold truncate text-[var(--accent)]">{t.headline}</span>
            <span
              className="chip chip-accent text-[9px] tracking-[0.1em] shrink-0"
              title="Fired by this tab's client-side monitor from live data. The alerts page has the full measurement record."
            >
              LIVE ALERT
            </span>
          </div>
          <div className="text-[11.5px] dim mt-1 leading-snug">{t.measurement}</div>
          {t.gapNote && <div className="text-[10px] warn mt-1 leading-snug">{t.gapNote}</div>}
        </Link>
      ))}
    </div>
  );
}
