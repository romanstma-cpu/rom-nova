"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { PageTitle } from "@/components/ui/PageTitle";
import { useApi, fmtAgo, fmtNum } from "@/lib/client";
import { Empty, Stat } from "@/components/ui/bits";
import { describeSocket, socketsSnapshot, socketsSnapshotServer, subscribeSockets, ACK_TIMEOUT_MS } from "@/lib/live/socket";
import { CURVE_CAP, PROGRAM_WIDE_RATES, RATES_MEASURED_ON, rpcPlan, SUBSCRIPTION_CAP } from "@/lib/live/rpc-ws";
import { nudgeStats } from "@/lib/alerts/cadence";
import { ledgerSnapshot, ledgerSnapshotServer, subscribeLedger, FILL_CAP, WALLET_CAP } from "@/lib/ledger/store";
import { MIN_OBSERVED_DAYS, MIN_ROUND_TRIPS } from "@/lib/ledger/reputation";
import type { ProviderHealth } from "@/lib/types";

/** Ticking clock so a socket's last-frame age counts without a re-fetch. */
function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * Every socket this tab has opened, with the two states a reader is allowed
 * to see and the numbers behind them.
 *
 * Read straight from the socket registry through `useSyncExternalStore`, not
 * from /api/status: the sockets live in this tab, and in server mode there
 * are none on the server. The empty state says so rather than implying a
 * socket that was never asked for is down.
 */
function LiveSockets() {
  const now = useNow();
  const sockets = useSyncExternalStore(subscribeSockets, socketsSnapshot, socketsSnapshotServer);
  const plan = rpcPlan();
  const nudges = nudgeStats();
  const kb = (b: number) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`);
  return (
    <div className="panel">
      <div className="panel-title px-3 pt-2.5 pb-1 flex items-baseline gap-2">
        <span>Live sockets</span>
        <span className="faint text-[10px] normal-case tracking-normal">
          keyless WebSockets opened by THIS tab, on demand — a socket is connected with a last-frame age, or it is down; there
          is no third state
        </span>
      </div>
      {sockets.length === 0 ? (
        <div className="px-3 py-3 text-[11.5px] dim">
          No socket has been opened in this tab yet. The launch feed holds the PumpPortal creation stream while it is
          visible; the alert monitor and the launch feed hold per-account subscriptions on Solana&apos;s pubsub socket
          while there is an armed rule or an on-curve launch to watch. Nothing connects speculatively.
        </div>
      ) : (
        <table className="w-full text-[12px]">
          <thead className="thead">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">Socket</th>
              <th className="text-left px-2 font-medium">State</th>
              <th className="text-right px-2 font-medium" title="subscribed / sent-awaiting-ack / unacked (no ack in 10s = NOT subscribed) / registered">
                Subscriptions
              </th>
              <th className="text-right px-2 font-medium">Reconnects</th>
              <th className="text-right px-2 font-medium" title="application-level pings sent after silence, and how many times silence outlived the timeout">
                Heartbeat
              </th>
              <th className="text-right px-2 font-medium">Frames</th>
              <th className="text-left px-3 font-medium">Note</th>
            </tr>
          </thead>
          <tbody className="num">
            {sockets.map((s) => {
              const d = describeSocket(s, now);
              return (
                <tr key={s.name} className="trow">
                  <td className="px-3 py-2" style={{ fontFamily: "var(--font-sans)" }} title={s.url}>
                    {s.name}
                  </td>
                  <td className={`px-2 ${d.up ? "pos" : s.wanted ? "neg" : "faint"}`} title={s.lastError ? `last error: ${s.lastError}` : undefined}>
                    {d.up ? "●" : "○"} {d.label}
                    {!s.wanted && s.state !== "open" ? " · not wanted" : ""}
                  </td>
                  <td
                    className="text-right px-2"
                    title={s.subscriptions.map((sub) => `${sub.key}: ${sub.state}${sub.messages ? ` · ${sub.messages} frames` : ""}`).join("\n") || "none registered"}
                  >
                    <span className="pos">{s.subscribed}</span>
                    <span className="faint">/</span>
                    <span className={s.acksPending ? "warn" : "faint"}>{s.acksPending}</span>
                    <span className="faint">/</span>
                    <span className={s.unacked ? "neg" : "faint"}>{s.unacked}</span>
                    <span className="faint">/{s.subscriptions.length}</span>
                  </td>
                  <td className="text-right px-2 dim">
                    {s.reconnects}
                    {s.attempts > 0 ? <span className="neg"> · {s.attempts} failing</span> : ""}
                  </td>
                  <td className="text-right px-2 dim">
                    {s.heartbeat.pings} pings · {s.heartbeat.timeouts} timeouts
                  </td>
                  <td className="text-right px-2 dim">
                    {s.messages} · {kb(s.bytes)}
                  </td>
                  <td className="px-3 text-[11px] dim" style={{ fontFamily: "var(--font-sans)" }}>
                    {s.name === "pumpportal-ws"
                      ? "subscribeNewToken only — the trade feeds need an API key. Frames carry no timestamp; pushed rows are stamped with receipt time and dated by a poll."
                      : `per-account logsSubscribe / accountSubscribe only. Plan: ${plan.wallets.length} wallet${plan.wallets.length === 1 ? "" : "s"}, ${plan.mints.length} mint${plan.mints.length === 1 ? "" : "s"}, ${plan.curves.length} curve${plan.curves.length === 1 ? "" : "s"} of a ${SUBSCRIPTION_CAP}-subscription cap (${CURVE_CAP} curves at most)` +
                        (plan.droppedWallets + plan.droppedMints + plan.droppedCurves > 0
                          ? ` — ${plan.droppedWallets + plan.droppedMints} rule account(s) and ${plan.droppedCurves} curve(s) NOT subscribed, over the cap`
                          : "")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="px-3 pb-3 pt-2 text-[11px] dim leading-relaxed" style={{ fontFamily: "var(--font-sans)" }}>
        <b>Why nothing here subscribes program-wide.</b> Measured {RATES_MEASURED_ON}:{" "}
        {PROGRAM_WIDE_RATES.map((r) => `${r.subject} → ${r.perSecond}/s, ${r.kbPerSecond} KB/s`).join(" · ")}. A tab
        watching the pump.fun program would decode two gigabytes an hour to extract a few events a minute, so every
        subscription names one account and the total is capped at {SUBSCRIPTION_CAP}. A subscribe request with no
        acknowledgement inside {ACK_TIMEOUT_MS / 1000}s is counted as NOT subscribed and shown as such; a notification
        never asserts a fill — it makes the alert monitor re-read that source now instead of on its cadence
        {nudges.nudges > 0
          ? ` (${nudges.nudges} such re-read${nudges.nudges === 1 ? "" : "s"} this session, last ${nudges.last ? `${nudges.last.key} ${fmtAgo(nudges.last.at, now)}` : "—"})`
          : " (none triggered yet this session)"}
        . Frame times are this machine&apos;s clock, uncorrected.
      </div>
    </div>
  );
}

/**
 * The wallet ledger: what this browser has recorded, and how far each wallet
 * is from a verdict. Read from the store directly, like the sockets — it
 * lives in this tab's IndexedDB and the server has no copy.
 */
function WalletLedger() {
  const now = useNow();
  const snap = useSyncExternalStore(subscribeLedger, ledgerSnapshot, ledgerSnapshotServer);
  const days = (d: number) => (d < 1 ? `${(d * 24).toFixed(1)}h` : `${d.toFixed(1)}d`);
  return (
    <div className="panel">
      <div className="panel-title px-3 pt-2.5 pb-1 flex items-baseline gap-2">
        <span>Wallet ledger</span>
        <span className="faint text-[10px] normal-case tracking-normal">
          fills kept across reads for wallets marked RECORD — the app&apos;s own reputation source, stored in this browser (
          {snap.backend}), {snap.wallets.filter((w) => w.recording).length}/{WALLET_CAP} recording, {snap.totalFills} fills, cap{" "}
          {FILL_CAP} per wallet
        </span>
      </div>
      {!snap.loaded ? (
        <div className="px-3 py-3 text-[11.5px] dim">reading the ledger…</div>
      ) : snap.wallets.length === 0 ? (
        <div className="px-3 py-3 text-[11.5px] dim">
          Nothing recorded yet. Open any real wallet and press RECORD THIS WALLET; the alert monitor then re-reads it every few
          minutes while the app is open, and after {MIN_ROUND_TRIPS} closed round trips over {MIN_OBSERVED_DAYS} observed days it
          carries a measured reputation the token scorer reads as smart money.
        </div>
      ) : (
        <table className="w-full text-[12px]">
          <thead className="thead">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">Wallet</th>
              <th className="text-left px-2 font-medium">State</th>
              <th className="text-right px-2 font-medium">Fills</th>
              <th className="text-right px-2 font-medium" title="days actually covered by reads / days from first read to last">Observed / span</th>
              <th className="text-right px-2 font-medium">Round trips</th>
              <th className="text-left px-2 font-medium">Verdict</th>
              <th className="text-right px-3 font-medium">Last read</th>
            </tr>
          </thead>
          <tbody className="num">
            {snap.wallets.map((w) => (
              <tr key={w.address} className="trow">
                <td className="px-3 py-2">
                  <a href={`/whale?a=${w.address}`} className="link">{w.address.slice(0, 4)}…{w.address.slice(-4)}</a>
                </td>
                <td className={`px-2 ${w.recording ? "pos" : "faint"}`}>{w.recording ? "● recording" : "○ paused"}</td>
                <td className="text-right px-2">{w.fills}</td>
                <td className="text-right px-2 dim">
                  {days(w.reputation.observedDays)} / {days(w.reputation.spanDays)}
                  {w.reputation.gaps.count > 0 && <span className="warn"> · {w.reputation.gaps.count} gap{w.reputation.gaps.count === 1 ? "" : "s"}</span>}
                </td>
                <td className="text-right px-2">{w.reputation.roundTrips}</td>
                <td className="px-2" style={{ fontFamily: "var(--font-sans)" }}>
                  {w.reputation.verdict === "measured" ? (
                    <span className={w.reputation.smart ? "pos" : ""}>
                      grade {w.reputation.grade} · {w.reputation.score}/100{w.reputation.smart ? " · smart money" : ""}
                    </span>
                  ) : (
                    <span className="dim">insufficient — needs {w.reputation.needs.join(", ")}</span>
                  )}
                </td>
                <td className="text-right px-3 dim">{w.lastReadAt ? fmtAgo(w.lastReadAt, now) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface Status {
  providers: ProviderHealth[];
  engine: {
    version: string;
    tokens: number;
    wallets: number;
    historicalTrades: number;
    liveTrades: number;
    eventsBuffered: number;
    simulatedUntil: number;
    genesis: number;
    seed: number;
  };
  dataMode?: {
    overall: "live" | "mixed" | "demo";
    live: string[];
    simulated: string[];
    /** Real, and narrower than "live" would let a reader assume. */
    bounded?: string[];
  };
}

export default function StatusPage() {
  const { data, error } = useApi<Status>("/api/status", 8000);
  if (!data) return <Empty>{error ? "Status endpoint unavailable — retrying automatically." : "CHECKING PROVIDERS…"}</Empty>;

  return (
    <div className="p-3 flex flex-col gap-3">
      <PageTitle title="STATUS" lede="Every source, socket and store this tab is using, and how live each one is" />

      {/* Leads with the answer. The provider table below is the evidence, but a
          reader arriving from the data-source chip wants the one-line version
          of which half of this terminal is real. */}
      {data.dataMode && (
        <div className="panel px-3 py-2.5">
          <div className="panel-title pb-1">What is real right now</div>
          <div className="flex flex-wrap gap-1.5 items-center text-[12px]">
            {data.dataMode.live.map((c) => (
              <span key={c} className="chip chip-accent">
                {c}
              </span>
            ))}
            {data.dataMode.simulated.map((c) => (
              <span key={c} className="chip chip-warn">
                {c} · simulated
              </span>
            ))}
          </div>
          {/* The third column, spelled out rather than chipped. These are real
              measurements with a limit attached, and the limit is a sentence —
              "last ~48h only (public RPC retention)" does not fit in a chip and
              is the entire point of listing it. A capability that is real and
              narrow is the easiest kind to over-read. */}
          {data.dataMode.bounded && data.dataMode.bounded.length > 0 && (
            <div className="mt-2">
              <div className="panel-title pb-1">Real, with a limit worth knowing</div>
              <ul className="text-[11.5px] dim space-y-1">
                {data.dataMode.bounded.map((b) => (
                  <li key={b}>· {b}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="hint mt-2">
            {data.dataMode.overall === "mixed"
              ? "Mixed. Live panels carry the vendor's name; anything unlabelled is the deterministic simulator, " +
                "and a factor nobody could measure is dropped from a score rather than counted as zero."
              : data.dataMode.overall === "live"
                ? "Every capability is served by a live source."
                : "Nothing is live — the whole terminal is the deterministic simulator."}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
        <Stat label="Engine">v{data.engine.version}</Stat>
        <Stat label="Universe seed">{data.engine.seed}</Stat>
        <Stat label="Tokens">{data.engine.tokens}</Stat>
        <Stat label="Wallets">{data.engine.wallets}</Stat>
        <Stat label="Historical trades">{fmtNum(data.engine.historicalTrades)}</Stat>
        <Stat label="Live trades">{fmtNum(data.engine.liveTrades)}</Stat>
        <Stat label="Sim heartbeat">{fmtAgo(data.engine.simulatedUntil)}</Stat>
      </div>

      <div className="panel">
        <div className="panel-title px-3 pt-2.5 pb-1">Data providers</div>
        <table className="w-full text-[12px]">
          <thead className="thead">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">Provider</th>
              <th className="text-left px-2 font-medium">Mode</th>
              <th className="text-left px-2 font-medium">Status</th>
              <th className="text-right px-2 font-medium">Latency</th>
              <th className="text-right px-2 font-medium">Error rate</th>
              <th className="text-right px-2 font-medium">Last data</th>
              <th className="text-left px-3 font-medium">Note</th>
            </tr>
          </thead>
          <tbody className="num">
            {data.providers.map((p) => (
              <tr key={p.name} className="trow">
                <td className="px-3 py-2" style={{ fontFamily: "var(--font-sans)" }}>{p.name}</td>
                <td className="px-2">
                  <span className={`chip ${p.mode === "live" ? "chip-pos" : p.mode === "demo" ? "chip-accent" : ""}`}>{p.mode}</span>
                </td>
                {/* "not asked yet" is its own state and reads as such. A
                    provider that has answered nothing is not healthy, and it is
                    not offline either — the table used to call it "● ok" with
                    0ms and 0% errors, which is every enabled provider on a cold
                    load of this very page. */}
                <td className="px-2">
                  <span
                    className={
                      p.status === "ok"
                        ? "pos"
                        : p.status === "degraded"
                          ? "warn"
                          : p.status === "unknown"
                            ? "dim"
                            : "faint"
                    }
                    title={p.status === "unknown" ? "enabled, but nothing has been requested from it yet this session" : undefined}
                  >
                    {p.status === "ok"
                      ? "● ok"
                      : p.status === "degraded"
                        ? "● degraded"
                        : p.status === "unknown"
                          ? "◌ not asked yet"
                          : "○ offline"}
                  </span>
                </td>
                <td className="text-right px-2 dim" title={p.latencyMs === undefined ? "no request has completed" : undefined}>
                  {p.latencyMs === undefined ? "—" : `${p.latencyMs}ms`}
                </td>
                <td
                  className={`text-right px-2 ${p.errorRatePct !== undefined && p.errorRatePct > 5 ? "neg" : "dim"}`}
                  title={p.errorRatePct === undefined ? "no requests to compute a rate over" : undefined}
                >
                  {p.errorRatePct === undefined ? "—" : `${p.errorRatePct}%`}
                </td>
                <td className="text-right px-2 faint">{p.lastDataTs ? fmtAgo(p.lastDataTs) : "—"}</td>
                <td className="px-3 text-[11px] dim" style={{ fontFamily: "var(--font-sans)" }}>{p.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <LiveSockets />
      <WalletLedger />

      <div className="panel p-3.5 text-[11.5px] dim leading-relaxed">
        <span className="panel-title block mb-1.5">Fallback chains</span>
        Token data: jupiter → birdeye → dexscreener → cached · Market data: birdeye → dexscreener → demo · Wallet activity:
        helius → demo · Labels: nansen → birdeye → demo · SOL reference price: coingecko ∥ cryptocom ∥ infstones (median,
        cross-checked) · Unconfigured providers fall back to the deterministic demo universe — never silently, always labeled.
      </div>
    </div>
  );
}
