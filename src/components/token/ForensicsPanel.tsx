"use client";

// The launch, read off the chain: bundled, sniped, and who is still in.
//
// Runs on its own for a mint under a day old — that is the moment the
// question is worth sixty RPC calls — and waits for a press on anything
// older, where the read is likelier to hit the retention edge and the answer
// matters less. Every share is against the supply the creation transaction
// minted; a read that could not measure the supply shows token counts and
// says the shares are unmeasured rather than dividing by a guess.

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, shortAddr } from "@/lib/client";
import type { EarlyWallet, LaunchForensicsResult } from "@/lib/providers/launch-forensics";
import { HOLDINGS_LOOKUPS, SNIPE_SLOTS } from "@/lib/providers/launch-forensics";

const AUTO_RUN_UNDER_MS = 24 * 3_600_000;
const INDEX_RETRIES = 4;
const INDEX_RETRY_MS = 15_000;

const pct = (x: number | undefined, digits = 1) => (x === undefined ? "—" : `${(x * 100).toFixed(digits)}%`);
const tokens = (x: number) => x.toLocaleString(undefined, { maximumFractionDigits: 0 });

function Row({ w, kind, supplyKnown }: { w: EarlyWallet; kind: string; supplyKnown: boolean }) {
  return (
    <tr className="trow">
      <td className="px-3 py-[5px]">
        <Link href={`/whale?a=${w.owner}`} className="link num">{shortAddr(w.owner)}</Link>
        {w.isDev && <span className="chip ml-1.5 text-[9px]">DEV</span>}
      </td>
      <td className="px-2 dim" style={{ fontFamily: "var(--font-sans)" }}>
        {kind}
        {!w.inCreateTx && w.slotOffset > 0 ? ` · +${w.slotOffset} slot${w.slotOffset === 1 ? "" : "s"}` : ""}
      </td>
      <td className="text-right px-2">{supplyKnown ? pct(w.boughtPct, 2) : tokens(w.boughtTokens)}</td>
      <td className="text-right px-2 dim">
        {w.holdsTokens === undefined ? (
          <span className="faint" title={`not looked up — the cap is ${HOLDINGS_LOOKUPS} wallets per read`}>—</span>
        ) : supplyKnown ? (
          pct(w.holdsPct, 2)
        ) : (
          tokens(w.holdsTokens)
        )}
      </td>
      <td className={`text-right px-3 ${w.soldPct === undefined ? "faint" : w.soldPct >= 0.5 ? "neg" : w.soldPct > 0 ? "warn" : "pos"}`}>
        {w.soldPct === undefined ? "—" : w.soldPct === 0 && (w.holdsTokens ?? 0) > w.boughtTokens ? "holding · added" : pct(w.soldPct, 0)}
      </td>
    </tr>
  );
}

/**
 * `asOf` is the detail's own timestamp rather than a clock read in render:
 * a component must be pure, and "is this mint young" is a fact about the
 * data it was handed, not about the moment it re-rendered.
 */
export function ForensicsPanel({ mint, createdAt, asOf }: { mint: string; createdAt: number; asOf: number }) {
  const young = asOf - createdAt < AUTO_RUN_UNDER_MS;
  // A fresh mint starts in the running state, so the auto-run effect below
  // never has to set state synchronously — it only fetches and reports back.
  const [state, setState] = useState<{ status: "idle" | "running" | "done" | "failed"; result?: LaunchForensicsResult; error?: string; note?: string }>(() => ({
    status: young ? "running" : "idle",
  }));

  const run = () => {
    setState({ status: "running" });
    apiGet<{ forensics: LaunchForensicsResult }>(`/api/tokens/${mint}/forensics`)
      .then((body) => setState({ status: "done", result: body.forensics }))
      .catch((err) => setState({ status: "failed", error: err instanceof Error ? err.message : String(err) }));
  };

  // Auto-run for a fresh mint. The effect runs once per mint; the read is
  // cached ten minutes on the other side, so a re-mount is not a re-read.
  //
  // A mint seconds old can be listed by Jupiter before the RPC's account
  // index has caught up, and the first listing comes back empty — measured:
  // nothing at forty seconds, 462 signatures at three minutes. That is not
  // a refusal to keep; it is retried a few times, fifteen seconds apart, and
  // the panel says it is waiting for the index rather than for the chain.
  useEffect(() => {
    if (!young) return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = (n: number) => {
      apiGet<{ forensics: LaunchForensicsResult }>(`/api/tokens/${mint}/forensics`)
        .then((body) => {
          if (dead) return;
          const r = body.forensics;
          if (!r.ok && /lists no transactions/.test(r.reason) && n < INDEX_RETRIES) {
            setState({ status: "running", note: `the RPC has not indexed this mint yet — retrying in ${INDEX_RETRY_MS / 1000}s (${n + 1}/${INDEX_RETRIES})` });
            timer = setTimeout(() => attempt(n + 1), INDEX_RETRY_MS);
            return;
          }
          setState({ status: "done", result: r });
        })
        .catch((err) => {
          if (!dead) setState({ status: "failed", error: err instanceof Error ? err.message : String(err) });
        });
    };
    attempt(0);
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mint]);

  const r = state.result;
  return (
    <div className="panel p-3">
      <div className="flex items-center gap-2 flex-wrap mb-1.5">
        <span className="panel-title">Launch forensics · read off the chain</span>
        {state.status === "running" && <span className="chip">READING THE LAUNCH…</span>}
        {state.status === "running" && state.note && <span className="text-[10.5px] dim">{state.note}</span>}
        {state.status === "idle" && (
          <button className="chip chip-accent cursor-pointer" onClick={run} title="~60 RPC calls: list the mint's transactions back to its creation, read the first 48, look up what the early wallets still hold">
            READ THE LAUNCH
          </button>
        )}
        {(state.status === "done" || state.status === "failed") && (
          <button className="link text-[10.5px] ml-auto" onClick={run}>re-read</button>
        )}
      </div>

      {state.status === "idle" && (
        <div className="text-[11px] dim leading-snug">
          Who bought inside the creation transaction, who bought in the creation slot and the next {SNIPE_SLOTS}, how much of the
          minted supply that was, and whether they still hold it. Runs on its own for mints under a day old; this one is older,
          so it waits for a press — the public endpoint keeps transaction bodies for about two days, and past that the read is
          refused rather than guessed.
        </div>
      )}

      {state.status === "failed" && <div className="text-[11.5px] neg">{state.error}</div>}

      {r && !r.ok && (
        <div className="text-[11.5px] leading-snug">
          <span className="chip mr-2">NOT READABLE</span>
          <span className="dim">{r.reason}</span>
        </div>
      )}

      {r && r.ok && (
        <>
          <div className="flex items-center gap-2 flex-wrap text-[11.5px] num">
            <span className={`chip ${(r.bundlerPct ?? 0) >= 0.1 ? "chip-danger" : ""}`} title="bought inside the creation transaction itself — the bundle">
              BUNDLED {r.supplyTokens !== undefined ? pct(r.bundlerPct) : `${tokens(r.bundled.reduce((s, w) => s + w.boughtTokens, 0))} tokens`}
            </span>
            <span className={`chip ${(r.sniperPct ?? 0) >= 0.1 ? "chip-danger" : ""}`} title={`bought in the creation slot or the next ${SNIPE_SLOTS} (~${(SNIPE_SLOTS * 0.4).toFixed(1)}s)`}>
              SNIPED {r.supplyTokens !== undefined ? pct(r.sniperPct) : `${tokens([...r.creationSlot, ...r.nextSlots].reduce((s, w) => s + w.boughtTokens, 0))} tokens`}
            </span>
            {r.dev && (
              <span className={`chip ${(r.devSoldPct ?? 0) >= 0.5 ? "chip-danger" : ""}`} title="the deployer's own buy in the creation transaction, and how much of it its balance still covers">
                DEV BOUGHT {r.supplyTokens !== undefined ? pct(r.dev.boughtPct) : tokens(r.dev.boughtTokens)}
                {r.devSoldPct !== undefined ? ` · SOLD ${pct(r.devSoldPct, 0)}` : " · balance not read"}
              </span>
            )}
            <span className="dim">
              early wallets still hold{" "}
              {r.earlyStillHeldPct === undefined ? <span className="faint">— (none looked up)</span> : <b className={r.earlyStillHeldPct < 0.5 ? "neg" : "pos"}>{pct(r.earlyStillHeldPct, 0)}</b>}{" "}
              of what they bought
            </span>
          </div>

          {r.bundled.length + r.creationSlot.length + r.nextSlots.length + (r.dev ? 1 : 0) > 0 && (
            <div className="overflow-auto mt-2">
              <table className="w-full text-[11.5px] min-w-[560px]">
                <thead className="thead">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium">Wallet</th>
                    <th className="text-left px-2 font-medium">Got in</th>
                    <th className="text-right px-2 font-medium">{r.supplyTokens !== undefined ? "bought · % supply" : "bought · tokens"}</th>
                    <th className="text-right px-2 font-medium" title="the balance of the account the launch buy landed in — tokens moved to another account would read as sold">holds now</th>
                    <th className="text-right px-3 font-medium">sold</th>
                  </tr>
                </thead>
                <tbody className="num">
                  {r.dev && <Row w={r.dev} kind="creation tx" supplyKnown={r.supplyTokens !== undefined} />}
                  {r.bundled.map((w) => <Row key={w.owner} w={w} kind="bundled · creation tx" supplyKnown={r.supplyTokens !== undefined} />)}
                  {r.creationSlot.map((w) => <Row key={w.owner} w={w} kind="creation slot" supplyKnown={r.supplyTokens !== undefined} />)}
                  {r.nextSlots.map((w) => <Row key={w.owner} w={w} kind="sniped" supplyKnown={r.supplyTokens !== undefined} />)}
                </tbody>
              </table>
            </div>
          )}

          <div className="text-[10.5px] faint mt-2 leading-snug">
            {r.provenance.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
            <div>
              {r.requests} RPC calls in {(r.durationMs / 1000).toFixed(1)}s · {r.signaturesListed.toLocaleString()} signatures · creation slot{" "}
              {r.createSlot.toLocaleString()}
              {r.createTs ? ` at ${new Date(r.createTs).toISOString().replace("T", " ").slice(0, 19)} UTC` : ""} · the score reads BUNDLED and
              SNIPED from this instead of standing those factors down.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
