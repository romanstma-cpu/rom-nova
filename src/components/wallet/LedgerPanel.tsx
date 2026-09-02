"use client";

// The wallet's recorded history and what it adds up to.
//
// Two states a reader must be able to tell apart at a glance: NOT RECORDING,
// where the only history is the two-day window every profile carries, and
// RECORDING, where the ledger has been keeping fills and the verdict is
// either "insufficient — here is what is still missing" or a measured grade
// with the evidence beside it. A grade never appears without its round-trip
// count and its observed days, because a grade off four trades would be the
// most memorable number on the page and the caveat under it the least.

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { fmtUsd, fmtAgo } from "@/lib/client";
import { alertsRaw, alertsRawServer, ensureWalletFillsRule, parseAlerts, subscribeAlerts, walletFillsRule } from "@/lib/alerts/store";
import type { WalletProfile } from "@/lib/types";
import {
  forgetWallet,
  ledgerSnapshot,
  ledgerSnapshotServer,
  recordFills,
  setRecording,
  subscribeLedger,
  WALLET_CAP,
} from "@/lib/ledger/store";
import { MIN_OBSERVED_DAYS, MIN_ROUND_TRIPS, SMART_SCORE } from "@/lib/ledger/reputation";

const pct = (x: number | undefined) => (x === undefined ? "—" : `${(x * 100).toFixed(0)}%`);
const days = (d: number) => (d < 1 ? `${(d * 24).toFixed(1)}h` : `${d.toFixed(1)}d`);

export function LedgerPanel({ address, profile }: { address: string; profile: WalletProfile }) {
  const snap = useSyncExternalStore(subscribeLedger, ledgerSnapshot, ledgerSnapshotServer);
  const entry = snap.wallets.find((w) => w.address === address);
  const rep = entry?.reputation;
  // The alerts blob through its own external store, so an armed rule shows
  // here the moment it exists and never desyncs the prerendered HTML.
  const alertsBlob = useSyncExternalStore(subscribeAlerts, alertsRaw, alertsRawServer);
  const fillsRule = walletFillsRule(address, parseAlerts(alertsBlob).rules.filter((r) => r.enabled));
  const full = snap.wallets.filter((w) => w.recording).length >= WALLET_CAP && !entry?.recording;

  const toggle = () => {
    const on = !(entry?.recording ?? false);
    const rec = setRecording(address, on);
    // Turning it on records what is already on screen, so the first read is
    // not wasted waiting for the monitor's next cadence.
    if (rec && on && profile.stage === "full") {
      recordFills(address, profile.fills, profile.coverage, Date.now());
    }
  };

  return (
    <div className="panel px-4 py-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="panel-title">Reputation · recorded by this app</span>
        <button
          onClick={toggle}
          disabled={full}
          className={`chip cursor-pointer ${entry?.recording ? "chip-accent" : ""}`}
          title={
            full
              ? `at the cap of ${WALLET_CAP} recorded wallets — forget one to record another`
              : entry?.recording
                ? "stop re-reading this wallet on the alert cadence; the history stays"
                : "keep every fill this wallet makes, re-reading it every few minutes while the app is open"
          }
        >
          {entry?.recording ? "● RECORDING" : "○ RECORD THIS WALLET"}
        </button>
        {entry && rep && (
          <span className="num text-[11px] dim">
            {entry.fills} fills over {days(rep.spanDays)} · observed {days(rep.observedDays)}
            {rep.gaps.count > 0 && (
              <span className="warn" title="stretches nobody was reading this wallet — the app was closed, or the endpoint refused. Not counted as observed.">
                {" "}· {rep.gaps.count} gap{rep.gaps.count === 1 ? "" : "s"} totalling {days(rep.gaps.days)}
              </span>
            )}
            {" "}· {entry.reads} read{entry.reads === 1 ? "" : "s"}
            {entry.lastReadAt ? `, last ${fmtAgo(entry.lastReadAt)}` : ""}
          </span>
        )}
        {entry && (
          <span className="ml-auto flex items-center gap-3">
            {/* Reputation into action: one press arms a fills alert on this
                wallet, evaluated on the monitor's cadence and pulled forward
                by the socket the moment the chain mentions the address. */}
            {fillsRule ? (
              <Link href="/alerts" className="chip chip-accent text-[9.5px]" title={`rule "${fillsRule.name}" is armed — manage it on the alerts page`}>
                ● ALERTING ON FILLS
              </Link>
            ) : (
              <button
                className="chip cursor-pointer text-[9.5px]"
                onClick={() => ensureWalletFillsRule(address, `${rep?.smart ? "smart money " : ""}${address.slice(0, 4)}…${address.slice(-4)} fills`)}
                title="arm an alert that fires on this wallet's next fill — re-read every few minutes while the app is open, sooner when the socket sees the address"
              >
                ○ ALERT ON FILLS
              </button>
            )}
            <button className="link text-[10.5px]" onClick={() => forgetWallet(address)} title="delete this wallet's recorded history">
              forget
            </button>
          </span>
        )}
      </div>

      {!entry && (
        <div className="text-[11.5px] dim mt-1.5 leading-relaxed">
          Every profile here is a ~2-day window, because that is all the keyless RPC retains. Recording keeps each
          read&apos;s fills, so a wallet watched for three weeks is judged on three weeks. It needs {MIN_ROUND_TRIPS} closed
          round trips over {MIN_OBSERVED_DAYS} observed days before it will say anything — a win rate off four trades is a
          coin flip wearing a percentage. Stored in this browser only ({snap.backend}).
        </div>
      )}

      {entry && rep && rep.verdict === "insufficient" && (
        <div className="text-[11.5px] mt-2 leading-relaxed">
          <span className="chip mr-2">INSUFFICIENT HISTORY</span>
          <span className="dim">
            Needs {rep.needs.join(" and ")}. So far: {rep.roundTrips} closed round trip{rep.roundTrips === 1 ? "" : "s"} across{" "}
            {rep.distinctMints} token{rep.distinctMints === 1 ? "" : "s"}, {rep.fills.priced} priced trades, {rep.fills.unpriced} unpriced,{" "}
            {rep.fills.nonTrade} transfers/LP moves excluded
            {rep.roundTrips > 0 && (
              <>
                {" "}— running {rep.wins}W/{rep.losses}L, {fmtUsd(rep.realizedPnlUsd)} realized, which is a sample and not
                yet a verdict
              </>
            )}
            . Leave the app open and it keeps reading.
          </span>
        </div>
      )}

      {entry && rep && rep.verdict === "measured" && (
        <div className="mt-2">
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`chip ${rep.smart ? "chip-accent" : ""}`} title={`score ${rep.score}/100 — half from win rate (35% → 0, 75% → full), half from profit factor on a log scale (1× → 0, 4× → full). Smart money at ${SMART_SCORE}+ with net positive P&L.`}>
              GRADE {rep.grade} · {rep.score}/100{rep.smart ? " · SMART MONEY" : ""}
            </span>
            <span className="num text-[11.5px]">
              <span className="dim">win rate</span> <span className={(rep.winRate ?? 0) >= 0.5 ? "pos" : "warn"}>{pct(rep.winRate)}</span>
              <span className="faint"> ({rep.wins}W/{rep.losses}L)</span>
            </span>
            <span className="num text-[11.5px]">
              <span className="dim">profit factor</span>{" "}
              {rep.profitFactor === undefined ? "—" : rep.profitFactor === Infinity ? "no losing trip yet" : `${rep.profitFactor.toFixed(2)}×`}
            </span>
            <span className="num text-[11.5px]">
              <span className="dim">realized</span> <span className={rep.realizedPnlUsd >= 0 ? "pos" : "neg"}>{fmtUsd(rep.realizedPnlUsd)}</span>
            </span>
            <span className="num text-[11.5px]">
              <span className="dim">median hold</span> {rep.medianHoldHours === undefined ? "—" : `${rep.medianHoldHours.toFixed(1)}h`}
            </span>
            <span className="num text-[11.5px]">
              <span className="dim">median size</span> {rep.medianRoundTripUsd === undefined ? "—" : fmtUsd(rep.medianRoundTripUsd)}
            </span>
          </div>
          <div className="text-[10.5px] faint mt-1.5 leading-relaxed">
            {rep.roundTrips} closed round trips across {rep.distinctMints} tokens, FIFO over {rep.fills.priced} priced trades;{" "}
            {rep.fills.unpriced} unpriced and {rep.fills.nonTrade} transfers/LP moves excluded
            {rep.unmatchedSellMints > 0 && `; sells on ${rep.unmatchedSellMints} token${rep.unmatchedSellMints === 1 ? "" : "s"} had no observed buy and book nothing`}
            . A filter over what was recorded, not a prediction — the token scorer reads SMART MONEY from this and from
            nothing else.
          </div>
        </div>
      )}
    </div>
  );
}
