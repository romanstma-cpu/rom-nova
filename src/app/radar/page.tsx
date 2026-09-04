"use client";

// Whale Radar — ROM Nova hunting smart money by itself.
//
// The default plane is THIS DEVICE: the radar engine running in this very
// tab, drinking the two keyless streams (PumpPortal creations, the pump.fun
// program's own log firehose), discovering wallets that enter launches big,
// journaling their fills into this browser's IndexedDB, scoring them from
// observed round trips only, and firing a signal when a proven one buys
// again. Arm it once; it keeps hunting on every page until disarmed, and
// its evidence survives reloads.
//
// The second plane is optional: a deployed Radar worker (worker/ in the
// repo) doing the same thing on a server around the clock, for people who
// want coverage while the machine is off. Same engine, same honesty.

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { fmtAge } from "@/lib/client";
import { Hint } from "@/components/ui/Hint";
import { Score } from "@/components/ui/bits";
import {
  holdRadar,
  radarConnect,
  radarDisconnect,
  radarServerSnapshot,
  radarSnapshot,
  subscribeRadar,
} from "@/lib/radar/client";
import {
  hunterServerSnapshot,
  hunterSnapshot,
  setHunterThreshold,
  startHunting,
  stopHunting,
  subscribeHunter,
  THRESHOLD_CHOICES,
  type HunterSnapshot,
} from "@/lib/radar/hunter";
import type { RadarState } from "@/lib/radar/client";

const shortAddr = (a: string) => (a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);

/** The one shape both planes render as. */
interface RadarView {
  label: string;
  signals: { wallet_address: string; wallet_score: number; token_address: string; token_name: string | null; buy_amount_sol: number; settled_sells?: number; at: number }[];
  wallets: { wallet_address: string; score: number; win_rate: number; total_trades: number; realized_pnl: number; settled_sells: number; unmeasured_sells: number }[];
  whales: { wallet: string; mint: string; sol: number; launchAgeMs: number | null; at: number }[];
  launches: { mint: string; name?: string; symbol?: string; vSol: number | null; at: number }[];
  trades: { wallet_address: string; token_address: string; buy_or_sell: "buy" | "sell"; amount_sol: number; at: number }[];
  asOf: number;
}

const deviceView = (h: HunterSnapshot): RadarView => ({
  label: "THIS DEVICE",
  signals: h.signals,
  wallets: h.top,
  whales: h.whales,
  launches: h.launches,
  trades: h.trades,
  asOf: h.asOf,
});

const workerView = (w: RadarState): RadarView => ({
  label: "REMOTE WORKER",
  signals: w.signals,
  wallets: w.wallets,
  whales: w.whales,
  launches: w.launches,
  trades: w.trades,
  asOf: w.asOf,
});

export default function RadarPage() {
  const hunter = useSyncExternalStore(subscribeHunter, hunterSnapshot, hunterServerSnapshot);
  const worker = useSyncExternalStore(subscribeRadar, radarSnapshot, radarServerSnapshot);
  const [source, setSource] = useState<"device" | "worker">("device");

  useEffect(() => holdRadar(), []);

  const workerUp = worker.phase === "connected";
  const view = source === "worker" && workerUp ? workerView(worker) : deviceView(hunter);
  const hunting = hunter.phase === "hunting";
  const rpc = hunter.streams.rpc;
  const pump = hunter.streams.pump;

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-[15px] font-semibold tracking-wide">WHALE RADAR</h1>
        <span className={`chip ${hunting ? "chip-pos" : ""}`}>
          {hunting ? "HUNTING · this device" : hunter.phase === "starting" ? "STARTING…" : "DISARMED"}
        </span>
        {hunting && pump && rpc && (
          <span className="chip text-[9.5px]">
            launches {pump.connected ? "✓" : "×"} · trades {rpc.connected ? "✓" : "×"}
            {rpc.connected ? ` · ${rpc.kbps.toFixed(0)} KB/s` : ""}
          </span>
        )}
      </div>

      <Hint id="radar">
        Armed, this app watches every pump.fun launch and every bonding-curve trade — two keyless public streams, read
        in this tab. A wallet that buys the threshold or more within ten minutes of a launch gets tracked; every
        pump.fun fill it makes afterwards is journaled into this browser and scored from observed round trips only.
        Sells whose buys the radar never saw are counted as unmeasured, never guessed, and a score is shrunk toward
        zero until six settled sells. When a wallet already scoring 70+ buys at least 1 SOL again, that is the signal —
        a toast anywhere in the app, and a row here. The trade stream costs real bandwidth (a few hundred KB/s,
        printed above), which is why hunting is a switch and not a default. It hunts only while the app is open; the
        journal survives reloads, so proven wallets stay proven. Nothing here executes trades, and a fresh radar
        showing zero signals is the honesty working — scores need settled round trips before they mean anything.
      </Hint>

      {/* the switch */}
      <div className="panel p-3.5 flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="panel-title">THIS DEVICE</span>
          {hunting || hunter.phase === "starting" ? (
            <button type="button" className="btn text-[11px]" onClick={() => stopHunting()}>
              DISARM
            </button>
          ) : (
            <button type="button" className="btn btn-primary text-[11px]" onClick={() => void startHunting()}>
              ARM THE RADAR
            </button>
          )}
          <label className="num text-[10.5px] faint flex items-center gap-1.5">
            whale threshold
            <select
              className="input text-[11px]"
              value={hunter.gates.whaleThresholdSol}
              disabled={hunter.phase === "starting"}
              onChange={(e) => void setHunterThreshold(Number(e.target.value))}
            >
              {THRESHOLD_CHOICES.map((t) => (
                <option key={t} value={t}>
                  {t} SOL
                </option>
              ))}
            </select>
          </label>
        </div>
        {hunting && (
          <div className="num text-[10.5px] faint">
            {hunter.counts.launches} launches · {hunter.counts.tradesSeen.toLocaleString()} trades observed ·{" "}
            {hunter.counts.whales} whales discovered · {hunter.counts.tracked} tracked ·{" "}
            {hunter.counts.journaled} fills journaled · {hunter.counts.signals} signals this session
          </div>
        )}
        {(hunter.hydrated.wallets > 0 || hunter.hydrated.fills > 0) && (
          <div className="text-[10.5px] dim">
            resumed with {hunter.hydrated.wallets} tracked wallets and {hunter.hydrated.fills} journaled fills from this
            browser&apos;s own record ({hunter.backend})
          </div>
        )}
        <div className="text-[10.5px] dim">
          coverage: pump.fun bonding-curve trades, program-wide, while this app is open. Trades on other venues and
          hours when the app is closed are not observed — the optional worker below exists for the second gap.
        </div>
      </div>

      {/* source toggle appears only once there are two sources to choose from */}
      {workerUp && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] faint">showing:</span>
          <button
            type="button"
            className={`chip text-[10px] cursor-pointer ${source === "device" ? "chip-accent" : ""}`}
            onClick={() => setSource("device")}
          >
            THIS DEVICE
          </button>
          <button
            type="button"
            className={`chip text-[10px] cursor-pointer ${source === "worker" ? "chip-accent" : ""}`}
            onClick={() => setSource("worker")}
          >
            REMOTE WORKER
          </button>
        </div>
      )}

      {/* the two planes that matter */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div className="panel flex flex-col min-h-[300px]">
          <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
            <span className="panel-title">SIGNALS · proven wallets buying</span>
            <span className="chip text-[9.5px]">{view.signals.length}</span>
          </div>
          <div className="overflow-y-auto max-h-[420px]">
            {view.signals.map((s, i) => (
              <div key={`${s.wallet_address}-${s.at}-${i}`} className="px-3 py-2 border-b border-[rgba(27,35,51,0.5)]">
                <div className="flex items-center gap-2">
                  <Score value={s.wallet_score} width={44} />
                  <Link href={`/token?m=${s.token_address}`} className="text-[12.5px] font-semibold link">
                    {s.token_name ?? shortAddr(s.token_address)}
                  </Link>
                  <span className="num text-[11px] ml-auto">{s.buy_amount_sol.toFixed(2)} SOL</span>
                </div>
                <div className="num text-[10.5px] faint mt-1">
                  <Link href={`/whale?a=${s.wallet_address}`} className="link">
                    {shortAddr(s.wallet_address)}
                  </Link>
                  {" · "}
                  {s.settled_sells ? `${s.settled_sells} settled sells` : "settled n/a"}
                  {" · "}
                  {fmtAge(Math.max(0, view.asOf - s.at))} ago
                </div>
              </div>
            ))}
            {view.signals.length === 0 && (
              <div className="px-3 py-8 text-center faint text-[11px]">
                {hunting || view.label === "REMOTE WORKER"
                  ? "No signals yet. A signal needs a wallet that ALREADY proved a 70+ score on settled sells — snipers flip in minutes, so an armed evening is usually enough for the first proofs. The panels below show the pipeline filling."
                  : "Arm the radar to start hunting."}
              </div>
            )}
          </div>
        </div>

        <div className="panel flex flex-col min-h-[300px]">
          <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
            <span className="panel-title">TOP TRACKED WALLETS</span>
            <span className="num text-[10px] faint">score = measured fills only</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11.5px]">
              <thead className="thead">
                <tr>
                  <th className="text-left px-3 py-1.5 font-medium">Wallet</th>
                  <th className="text-right px-2 font-medium">Score</th>
                  <th className="text-right px-2 font-medium">Win</th>
                  <th className="text-right px-2 font-medium">PNL SOL</th>
                  <th className="text-right px-2 font-medium" title="sells with a fully observed cost basis / sells the radar refused to score">
                    settled/unm.
                  </th>
                  <th className="text-right px-3 font-medium">Fills</th>
                </tr>
              </thead>
              <tbody className="num">
                {view.wallets.map((w) => (
                  <tr key={w.wallet_address} className="trow">
                    <td className="px-3 py-1.5">
                      <Link href={`/whale?a=${w.wallet_address}`} className="link">
                        {shortAddr(w.wallet_address)}
                      </Link>
                    </td>
                    <td className="text-right px-2">
                      <Score value={w.score} width={40} />
                    </td>
                    <td className="text-right px-2">{(w.win_rate * 100).toFixed(0)}%</td>
                    <td className={`text-right px-2 ${w.realized_pnl >= 0 ? "pos" : "neg"}`}>{w.realized_pnl.toFixed(2)}</td>
                    <td className="text-right px-2 dim">
                      {w.settled_sells}/{w.unmeasured_sells}
                    </td>
                    <td className="text-right px-3 dim">{w.total_trades}</td>
                  </tr>
                ))}
                {view.wallets.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center faint text-[11px]">
                      {hunting ? "No wallets tracked yet — discoveries land here as whales enter fresh launches." : "—"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* the pipeline filling */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="panel flex flex-col">
          <div className="px-3 pt-2.5 pb-1.5 panel-title">DISCOVERIES · whales entering launches</div>
          <div className="overflow-y-auto max-h-[300px]">
            {view.whales.map((w, i) => (
              <div key={`${w.wallet}-${w.at}-${i}`} className="px-3 py-1.5 border-b border-[rgba(27,35,51,0.5)] num text-[11px] flex items-center gap-2">
                <Link href={`/whale?a=${w.wallet}`} className="link">
                  {shortAddr(w.wallet)}
                </Link>
                <span className="pos">{w.sol.toFixed(1)} SOL</span>
                <Link href={`/token?m=${w.mint}`} className="link faint">
                  {shortAddr(w.mint)}
                </Link>
                <span className="faint ml-auto">
                  {w.launchAgeMs !== null ? `${Math.max(0, Math.round(w.launchAgeMs / 1000))}s post-launch` : ""}
                </span>
              </div>
            ))}
            {view.whales.length === 0 && <div className="px-3 py-6 text-center faint text-[11px]">—</div>}
          </div>
        </div>

        <div className="panel flex flex-col">
          <div className="px-3 pt-2.5 pb-1.5 panel-title">JOURNAL · tracked-wallet fills</div>
          <div className="overflow-y-auto max-h-[300px]">
            {view.trades.slice(0, 60).map((t, i) => (
              <div key={`${t.wallet_address}-${t.at}-${i}`} className="px-3 py-1.5 border-b border-[rgba(27,35,51,0.5)] num text-[11px] flex items-center gap-2">
                <span className={t.buy_or_sell === "buy" ? "pos" : "neg"}>{t.buy_or_sell.toUpperCase()}</span>
                <span>{t.amount_sol.toFixed(2)} SOL</span>
                <Link href={`/token?m=${t.token_address}`} className="link faint">
                  {shortAddr(t.token_address)}
                </Link>
                <span className="faint ml-auto">{shortAddr(t.wallet_address)}</span>
              </div>
            ))}
            {view.trades.length === 0 && <div className="px-3 py-6 text-center faint text-[11px]">—</div>}
          </div>
        </div>

        <div className="panel flex flex-col">
          <div className="px-3 pt-2.5 pb-1.5 panel-title">LAUNCHES · seen by the radar</div>
          <div className="overflow-y-auto max-h-[300px]">
            {view.launches.map((l, i) => (
              <div key={`${l.mint}-${i}`} className="px-3 py-1.5 border-b border-[rgba(27,35,51,0.5)] num text-[11px] flex items-center gap-2">
                <Link href={`/token?m=${l.mint}`} className="link">
                  {l.symbol || l.name || shortAddr(l.mint)}
                </Link>
                {l.vSol !== null && <span className="faint">{l.vSol.toFixed(1)} vSOL</span>}
                <span className="faint ml-auto">{fmtAge(Math.max(0, view.asOf - l.at))} ago</span>
              </div>
            ))}
            {view.launches.length === 0 && <div className="px-3 py-6 text-center faint text-[11px]">—</div>}
          </div>
        </div>
      </div>

      {/* the optional 24/7 plane */}
      <div className="panel p-3.5 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="panel-title">REMOTE WORKER · optional, for 24/7</span>
          <span className={`chip text-[9.5px] ${workerUp ? "chip-pos" : ""}`}>
            {workerUp ? "CONNECTED" : worker.phase === "connecting" ? "CONNECTING…" : worker.phase === "error" ? "FAILED" : "not connected"}
          </span>
        </div>
        <div className="text-[11px] dim leading-relaxed">
          This device stops hunting when the app closes. The repo ships the same engine as a deployable service (
          <a className="link" href="https://github.com/romanstma-cpu/rom-nova/tree/main/worker#readme" target="_blank" rel="noreferrer">
            worker/README
          </a>
          ) that never sleeps; connect yours here and flip the source toggle above to read its feed.
        </div>
        <form
          className="flex gap-2 flex-wrap items-center"
          onSubmit={(e) => {
            e.preventDefault();
            radarConnect(String(new FormData(e.currentTarget).get("url") ?? ""));
          }}
        >
          <input
            key={worker.url}
            name="url"
            type="url"
            defaultValue={worker.url}
            placeholder="https://rom-nova-radar.onrender.com"
            className="input num text-[12px] flex-1 min-w-[260px]"
            aria-label="Radar worker URL"
          />
          {workerUp || worker.phase === "connecting" || (worker.enabled && worker.phase === "error") ? (
            <button type="button" className="btn text-[11px]" onClick={() => radarDisconnect()}>
              {workerUp ? "DISCONNECT" : "STOP RETRYING"}
            </button>
          ) : (
            <button type="submit" className="btn text-[11px]">
              CONNECT
            </button>
          )}
        </form>
        {worker.error && <div className="text-[11px] text-[var(--danger)]">{worker.error}</div>}
      </div>

      <p className="text-[10px] faint px-1 pb-2 leading-relaxed">
        Radar data is measured by YOUR app (or your worker) from its own observed stream: pump.fun bonding-curve
        trades, program-wide, while armed. Scores stand on settled, fully-observed round trips — the settled/unmeasured
        column shows how much of each wallet&apos;s record the score actually rests on. Signals are observations, not
        advice, and nothing here executes trades.
      </p>
    </div>
  );
}
