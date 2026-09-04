"use client";

// Whale Radar — the feed from your own autonomous scanner.
//
// Everything on this page is pushed by a Radar worker the visitor deploys
// and owns (worker/ in the repo, one free Render blueprint). The app never
// ships a shared backend: your worker, your database, your URL, stored in
// this browser only. Without a worker the page explains itself and the rest
// of the app is untouched — this is an optional plane, not a dependency.

import { useEffect } from "react";
import Link from "next/link";
import { useSyncExternalStore } from "react";
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

const shortAddr = (a: string) => (a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);

export default function RadarPage() {
  const st = useSyncExternalStore(subscribeRadar, radarSnapshot, radarServerSnapshot);

  useEffect(() => holdRadar(), []);

  const counts = (st.health?.counts ?? null) as Record<string, number> | null;
  const streams = (st.health?.streams ?? null) as Record<string, { connected?: boolean } | null> | null;

  const connect = (form: FormData) => {
    const url = String(form.get("url") ?? "");
    radarConnect(url);
  };

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-[15px] font-semibold tracking-wide">WHALE RADAR</h1>
        <span
          className={`chip ${st.phase === "connected" ? "chip-pos" : st.phase === "error" ? "chip-danger" : ""}`}
        >
          {st.phase === "connected"
            ? "CONNECTED · your worker"
            : st.phase === "connecting"
              ? "CONNECTING…"
              : st.phase === "error"
                ? "CONNECTION FAILED"
                : "NOT CONNECTED"}
        </span>
        {st.phase === "connected" && streams && (
          <span className="chip text-[9.5px]">
            streams: pumpportal {streams.pumpportal?.connected ? "✓" : "×"} · rpc {streams.rpc_logs?.connected ? "✓" : "×"}
          </span>
        )}
      </div>

      <Hint id="radar">
        The Radar is the autonomous half of ROM Nova: a worker process you deploy once (free Render blueprint in the
        repo) that watches every pump.fun launch and every bonding-curve trade around the clock — even while this app is
        closed. A wallet that buys 10+ SOL within minutes of a launch gets tracked; every fill it makes afterwards is
        journaled and scored from observed data only — sells without an observed cost basis are counted as unmeasured,
        never guessed. When a wallet whose score already exceeds 70 buys again, the worker pushes the signal you see
        here, and writes everything to your own Supabase. Nothing on this page executes trades, and a fresh worker
        showing zero proven wallets is the honesty working: scores need settled round trips before they mean anything.
      </Hint>

      {/* config */}
      <div className="panel p-3.5 flex flex-col gap-2">
        <span className="panel-title">WORKER CONNECTION</span>
        <form
          className="flex gap-2 flex-wrap items-center"
          onSubmit={(e) => {
            e.preventDefault();
            connect(new FormData(e.currentTarget));
          }}
        >
          <input
            key={st.url}
            name="url"
            type="url"
            defaultValue={st.url}
            placeholder="https://rom-nova-radar.onrender.com"
            className="input num text-[12px] flex-1 min-w-[260px]"
            aria-label="Radar worker URL"
          />
          {st.phase === "connected" || st.phase === "connecting" ? (
            <button type="button" className="btn text-[11px]" onClick={() => radarDisconnect()}>
              DISCONNECT
            </button>
          ) : (
            <button type="submit" className="btn btn-primary text-[11px]">
              CONNECT
            </button>
          )}
        </form>
        {st.error && <div className="text-[11px] text-[var(--danger)]">{st.error}</div>}
        {st.phase === "connected" && (
          <div className="num text-[10.5px] faint">
            {counts
              ? `${counts.launches ?? 0} launches · ${counts.whales ?? 0} whales discovered · ${counts.tracked ?? 0} tracked · ${counts.journaled ?? 0} fills journaled · ${counts.signals ?? 0} signals`
              : "waiting for status…"}
          </div>
        )}
        {st.coverage && <div className="text-[10.5px] dim">coverage: {st.coverage}</div>}
        {st.phase === "off" && (
          <div className="text-[11.5px] dim leading-relaxed">
            No worker yet? The repo ships one:{" "}
            <a
              className="link"
              href="https://github.com/romanstma-cpu/rom-nova/tree/main/worker#readme"
              target="_blank"
              rel="noreferrer"
            >
              worker/README
            </a>{" "}
            — create a free Supabase project, run one SQL file, deploy the Render blueprint, paste your keys into
            Render&apos;s own dashboard (never anywhere else), then paste the service URL above. The URL is stored in
            this browser only.
          </div>
        )}
      </div>

      {/* the two planes that matter */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div className="panel flex flex-col min-h-[300px]">
          <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
            <span className="panel-title">SIGNALS · proven wallets buying</span>
            <span className="chip text-[9.5px]">{st.signals.length}</span>
          </div>
          <div className="overflow-y-auto max-h-[420px]">
            {st.signals.map((s, i) => (
              <div key={`${s.wallet_address}-${s.timestamp}-${i}`} className="px-3 py-2 border-b border-[rgba(27,35,51,0.5)]">
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
                  {fmtAge(Math.max(0, st.asOf - s.at))} ago
                </div>
              </div>
            ))}
            {st.signals.length === 0 && (
              <div className="px-3 py-8 text-center faint text-[11px]">
                {st.phase === "connected"
                  ? "No signals yet. A signal needs a wallet that ALREADY proved a 70+ score on settled sells — on a fresh worker that takes hours to days of runtime. The discoveries and journal below show the pipeline filling."
                  : "Connect your worker to see its signals."}
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
                  <th className="text-right px-2 font-medium" title="sells with a fully observed cost basis / sells the worker refused to score">
                    settled/unm.
                  </th>
                  <th className="text-right px-3 font-medium">Fills</th>
                </tr>
              </thead>
              <tbody className="num">
                {st.wallets.map((w) => (
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
                {st.wallets.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center faint text-[11px]">
                      {st.phase === "connected" ? "No wallets tracked yet — discoveries land here as whales enter fresh launches." : "—"}
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
            {st.whales.map((w, i) => (
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
            {st.whales.length === 0 && <div className="px-3 py-6 text-center faint text-[11px]">—</div>}
          </div>
        </div>

        <div className="panel flex flex-col">
          <div className="px-3 pt-2.5 pb-1.5 panel-title">JOURNAL · tracked-wallet fills</div>
          <div className="overflow-y-auto max-h-[300px]">
            {st.trades.slice(0, 60).map((t, i) => (
              <div key={`${t.wallet_address}-${t.timestamp}-${i}`} className="px-3 py-1.5 border-b border-[rgba(27,35,51,0.5)] num text-[11px] flex items-center gap-2">
                <span className={t.buy_or_sell === "buy" ? "pos" : "neg"}>{t.buy_or_sell.toUpperCase()}</span>
                <span>{t.amount_sol.toFixed(2)} SOL</span>
                <Link href={`/token?m=${t.token_address}`} className="link faint">
                  {shortAddr(t.token_address)}
                </Link>
                <span className="faint ml-auto">{shortAddr(t.wallet_address)}</span>
              </div>
            ))}
            {st.trades.length === 0 && <div className="px-3 py-6 text-center faint text-[11px]">—</div>}
          </div>
        </div>

        <div className="panel flex flex-col">
          <div className="px-3 pt-2.5 pb-1.5 panel-title">LAUNCHES · seen by the worker</div>
          <div className="overflow-y-auto max-h-[300px]">
            {st.launches.map((l, i) => (
              <div key={`${l.mint}-${i}`} className="px-3 py-1.5 border-b border-[rgba(27,35,51,0.5)] num text-[11px] flex items-center gap-2">
                <Link href={`/token?m=${l.mint}`} className="link">
                  {l.symbol || l.name || shortAddr(l.mint)}
                </Link>
                {l.vSol !== null && <span className="faint">{l.vSol.toFixed(1)} vSOL</span>}
                <span className="faint ml-auto">{fmtAge(Math.max(0, st.asOf - l.at))} ago</span>
              </div>
            ))}
            {st.launches.length === 0 && <div className="px-3 py-6 text-center faint text-[11px]">—</div>}
          </div>
        </div>
      </div>

      <p className="text-[10px] faint px-1 pb-2 leading-relaxed">
        Radar data is measured by YOUR worker from its own observed stream: pump.fun bonding-curve trades program-wide,
        plus Helius off-curve coverage only if you configured a key. Scores stand on settled, fully-observed round trips
        — the settled/unmeasured column shows how much of each wallet&apos;s record the score actually rests on. Signals
        are observations, not advice, and nothing here executes trades.
      </p>
    </div>
  );
}
