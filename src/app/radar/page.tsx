"use client";

// Whale Radar — ROM Nova hunting smart money by itself, and the copy desk
// that turns a signal into something a person can act on.
//
// The default plane is THIS DEVICE: the radar engine running in this very
// tab, drinking the two keyless streams (PumpPortal creations, the pump.fun
// program's own log firehose), discovering wallets that enter launches big,
// journaling their fills into this browser's IndexedDB, scoring them from
// observed round trips only, and firing a signal when a proven one buys
// again. Arm it once; it keeps hunting on every page until disarmed, and
// its evidence survives reloads.
//
// Since 1.17.0 a signal is not the end of the story. The same stream grades
// it — what the token was worth one, five, fifteen and sixty minutes later
// to someone who bought on the alert — and hears the signal wallet sell,
// which is the exit a copier most needs. The leaderboard ranks wallets by
// what FOLLOWING them paid, not only by what they made themselves; a sniper
// flipping in forty seconds has a fine record nobody can copy. The desk
// below the signals keeps the reader's own follows, marked to the last
// trade seen, sized by a plan they set. Nova still executes nothing: every
// trade happens in the reader's own wallet, one click away.
//
// The second plane is optional: a deployed Radar worker (worker/ in the
// repo) doing the same thing on a server around the clock. Same engine,
// same grades, same honesty.

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { fmtAge, fmtUsd, useApi } from "@/lib/client";
import { Hint } from "@/components/ui/Hint";
import { PageTitle } from "@/components/ui/PageTitle";
import { Score } from "@/components/ui/bits";
import { HeliusKeyCard } from "@/components/radar/HeliusKeyCard";
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
  lastPriceOf,
  setHunterThreshold,
  startHunting,
  stopHunting,
  subscribeHunter,
  THRESHOLD_CHOICES,
  type HunterSnapshot,
} from "@/lib/radar/hunter";
import {
  addFollow,
  closeFollow,
  copyPlanServerSnapshot,
  copyPlanSnapshot,
  copyRecord,
  COST_CHOICES,
  followReturn,
  followReturnNet,
  followsServerSnapshot,
  followsSnapshot,
  removeFollow,
  RISK_CHOICES,
  setCopyPlan,
  subscribeFollows,
  suggestedSizeSol,
  type Follow,
} from "@/lib/radar/follows";
import { signalKeyOf, type RadarSignalRow } from "@/lib/radar/journal";
import { notifyState, notifyStateServer, requestNotifyPermission, subscribeNotify } from "@/lib/alerts/notify";
import type { RadarState } from "@/lib/radar/client";

/** A median hold under this is a record nobody can copy: the wallet is out before a person is in. */
const UNCOPYABLE_HOLD_MS = 60_000;

/** What each earned label means, and how loudly to paint it. */
const LABELS: Record<string, { title: string; cls: string }> = {
  dev: { title: "created a token the radar saw launch; its trades in that token are the developer's, not a whale's", cls: "chip-warn" },
  sniper: { title: "median settled hold under a minute: out before a person is in", cls: "chip-neg" },
  flipper: { title: "median settled hold under thirty minutes", cls: "" },
  holder: { title: "median settled hold over a day", cls: "chip-pos" },
  accumulator: { title: "three or more buys of one token with no sell of it in its recent fills: building a position", cls: "chip-accent" },
  distributor: { title: "recent sells outnumber buys two to one: unloading", cls: "chip-warn" },
  "wash-like": { title: "four or more alternating buy/sell legs on one token inside ten minutes, ending flat: volume, not conviction", cls: "chip-neg" },
};
const BEHAVIOUR_LABEL: Record<string, { text: string; cls: string }> = {
  dormant_buy: { text: "DORMANT WOKE", cls: "chip-warn" },
  accumulation: { text: "ACCUMULATING", cls: "chip-accent" },
  distribution: { text: "DISTRIBUTING", cls: "chip-warn" },
  wash_like: { text: "WASH-LIKE", cls: "chip-neg" },
};

const shortAddr = (a: string) => (a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);
const fmtRet = (r: number) => `${r >= 0 ? "+" : ""}${(r * 100).toFixed(r > -0.1 && r < 0.1 ? 1 : 0)}%`;
const retCls = (r: number) => (r >= 0.1 ? "pos" : r <= -0.1 ? "neg" : "dim");
const fmtHold = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
const fmtPriceSol = (p: number) => (p >= 0.01 ? p.toFixed(4) : p.toExponential(2));

/** Where a reader trades it, in their own wallet. Nova opens a tab and steps back. */
const TRADE_LINKS: { label: string; href: (mint: string) => string }[] = [
  { label: "pump.fun", href: (m) => `https://pump.fun/coin/${m}` },
  { label: "Jupiter", href: (m) => `https://jup.ag/swap/SOL-${m}` },
  { label: "GMGN", href: (m) => `https://gmgn.ai/sol/token/${m}` },
  { label: "DexScreener", href: (m) => `https://dexscreener.com/solana/${m}` },
];

/** The one shape both planes render as. */
interface RadarView {
  label: string;
  signals: (RadarSignalRow & { at: number })[];
  wallets: {
    wallet_address: string;
    score: number;
    win_rate: number;
    total_trades: number;
    realized_pnl: number;
    settled_sells: number;
    unmeasured_sells: number;
    labels: string[];
    consistency: number | null;
    max_drawdown_sol: number;
    avg_hold_ms: number | null;
    median_hold_ms: number | null;
    follow_ret_5m: number | null;
    follow_hit_rate: number | null;
    signals_graded: number;
  }[];
  behaviours: { behaviour: string; wallet: string; mint: string; sol: number; detail: string; at: number }[];
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
  behaviours: h.behaviours,
  asOf: h.asOf,
});

const workerView = (w: RadarState): RadarView => ({
  label: "REMOTE WORKER",
  signals: w.signals,
  wallets: w.wallets,
  whales: w.whales,
  launches: w.launches,
  trades: w.trades,
  behaviours: w.behaviours,
  asOf: w.asOf,
});

/** The empty line for a pipeline panel: what fills it, in the state we are in. */
function Waiting({ hunting, idle, live }: { hunting: boolean; idle: string; live: string }) {
  return <div className="px-3 py-6 text-center faint text-[11px] leading-relaxed">{hunting ? live : idle}</div>;
}

/** One horizon's grade: the return, or an ellipsis while it is still coming. */
function Grade({ label, ret, title }: { label: string; ret: number | null | undefined; title: string }) {
  return (
    <span className="num text-[10.5px]" title={title}>
      <span className="faint">{label} </span>
      {typeof ret === "number" ? <span className={retCls(ret)}>{fmtRet(ret)}</span> : <span className="faint">…</span>}
    </span>
  );
}

export default function RadarPage() {
  const hunter = useSyncExternalStore(subscribeHunter, hunterSnapshot, hunterServerSnapshot);
  const worker = useSyncExternalStore(subscribeRadar, radarSnapshot, radarServerSnapshot);
  const follows = useSyncExternalStore(subscribeFollows, followsSnapshot, followsServerSnapshot);
  const plan = useSyncExternalStore(subscribeFollows, copyPlanSnapshot, copyPlanServerSnapshot);
  const notif = useSyncExternalStore(subscribeNotify, notifyState, notifyStateServer);
  // The live cross-checked SOL price, for PNL in dollars beside PNL in SOL.
  const { data: market } = useApi<{ reference: { priceUsd: number } | null }>("/api/market", 30_000);
  const solUsd = market?.reference?.priceUsd ?? null;
  const [source, setSource] = useState<"device" | "worker">("device");
  const [bankrollDraft, setBankrollDraft] = useState<string | null>(null);
  /** An "I followed" form open on one signal: the entry price and size the reader confirms. */
  const [followDraft, setFollowDraft] = useState<{ key: string; price: string; size: string } | null>(null);
  /** A close form open on one follow. */
  const [closeDraft, setCloseDraft] = useState<{ id: string; price: string } | null>(null);

  useEffect(() => holdRadar(), []);

  const workerUp = worker.phase === "connected";
  const view = source === "worker" && workerUp ? workerView(worker) : deviceView(hunter);
  const hunting = hunter.phase === "hunting";
  const starting = hunter.phase === "starting";
  const armed = hunting || starting;
  const feeding = hunting || view.label === "REMOTE WORKER";
  const rpc = hunter.streams.rpc;
  const pump = hunter.streams.pump;
  const helius = hunter.helius;
  // The biggest discovery in view sets the scale for the size bars.
  const maxWhaleSol = view.whales.reduce((m, w) => Math.max(m, w.sol), 1);
  // The extensions fold opens itself when either one is in use.
  const extensionsInUse = helius.keySet || worker.enabled || workerUp;
  const walletsByAddr = new Map(view.wallets.map((w) => [w.wallet_address, w]));
  const signalsByKey = new Map(view.signals.map((s) => [s.signal_key ?? signalKeyOf(s), s]));
  const sizeSol = suggestedSizeSol(plan);
  const record = copyRecord(follows, plan.costPct);
  const openFollows = follows.filter((f) => f.closedAt === null).length;

  /** The best mark the app has for a mint right now: the last trade the radar saw. */
  const markOf = (mint: string): number | null => hunter.prices[mint]?.priceSol ?? lastPriceOf(mint)?.priceSol ?? null;

  const commitBankroll = () => {
    if (bankrollDraft !== null) {
      const v = Number(bankrollDraft);
      if (v > 0) setCopyPlan({ ...plan, bankrollSol: v });
      setBankrollDraft(null);
    }
  };

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`radar-sweep${hunting ? " on" : ""}`} aria-hidden="true" />
        <PageTitle title="WHALE RADAR" lede="Finds and scores whale wallets on its own, grades its own signals, and runs your copy desk" />
        <span className={`chip ${hunting ? "chip-pos" : ""}`}>
          {hunting ? (
            <>
              <span className="live-dot" />
              HUNTING · this device
            </>
          ) : starting ? (
            "STARTING…"
          ) : (
            "DISARMED"
          )}
        </span>
        {hunting && pump && rpc && (
          <span className="chip text-[9.5px]" title="the two keyless streams the radar drinks: launches from PumpPortal, trades from the pump.fun program log">
            launches {pump.connected ? "✓" : "×"} · trades {rpc.connected ? "✓" : "×"}
            {rpc.connected ? ` · ${rpc.kbps.toFixed(0)} KB/s` : ""}
          </span>
        )}
      </div>

      <Hint
        id="radar"
        summary="Armed, it watches every pump.fun launch and trade in this tab, tracks wallets that enter launches big, scores and labels them from observed fills, signals when a proven one buys, grades every signal from the same stream, tells you when that wallet sells, and flags dormant wallets waking up and wash-like trading."
      >
        Armed, this app watches every pump.fun launch and every bonding-curve trade — two keyless public streams, read
        in this tab. A wallet that buys the threshold or more within ten minutes of a launch gets tracked; every
        pump.fun fill it makes afterwards is journaled into this browser and scored from observed round trips only.
        Sells whose buys the radar never saw are counted as unmeasured, never guessed, and a score is shrunk toward
        zero until six settled sells. When a wallet already scoring 70+ buys at least 1 SOL again, that is the signal —
        a toast anywhere in the app, an OS notification if you enabled them on Alerts, and a row here. <b>Then the
        signal is graded:</b> the token&apos;s price at the first trade one, five, fifteen and sixty minutes later,
        against the signal&apos;s own fill price, is what a buyer on the alert was sitting on; if the token goes quiet
        the grade is marked to the last trade seen and flagged stale, and off the bonding curve the stream is blind.
        <b> Follow 5m</b> on the leaderboard is the median of those five-minute grades per wallet — the number that
        says whether following this wallet has paid, as opposed to whether the wallet paid itself. <b>Exits:</b> the
        signal wallet&apos;s first sell after its signal is heard and announced, with how much it sold and at what
        return, because a copier who hears the buy and not the sell is holding the bag. <b>The copy desk</b> sizes
        each signal from a bankroll and a risk you set, opens the token in your own trading site, and keeps the
        follows you record — your entry, the live mark, the wallet&apos;s exit, your close. <b>Labels</b> are
        earned, never assigned: sniper, flipper and holder from the median settled hold after three sells;
        accumulator and distributor from a wallet&apos;s recent fills; wash-like from four alternating legs inside ten
        minutes ending flat; dev when the radar saw the wallet create a token. <b>Behaviour reads</b> fire once at a
        threshold — a wallet quiet for a week buying five SOL or more, a third buy with no sell, a third bare sell, a
        fourth flat leg — and the two worth interrupting for reach the toasts. Consistency is the mean of per-trade
        ROI over its spread, the shape of a Sharpe ratio on settled sells and not annualized; drawdown is the
        deepest fall of realized PNL from its best. Nothing here executes trades or touches a wallet; every number in
        your record is one you typed. A fresh radar showing zero signals is the honesty working.
      </Hint>

      {/* the switch */}
      <div className="panel p-3.5 flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          {armed ? (
            <button type="button" className="btn text-[11px]" onClick={() => stopHunting()}>
              DISARM
            </button>
          ) : (
            <button type="button" className="btn btn-primary text-[11px]" onClick={() => void startHunting()}>
              ARM THE RADAR
            </button>
          )}
          <label className="num text-[10.5px] faint flex items-center gap-1.5" title="a wallet is worth tracking when it enters a launch with at least this much, within ten minutes">
            track wallets entering with ≥
            <select
              className="input text-[11px]"
              value={hunter.gates.whaleThresholdSol}
              disabled={starting}
              onChange={(e) => void setHunterThreshold(Number(e.target.value))}
            >
              {THRESHOLD_CHOICES.map((t) => (
                <option key={t} value={t}>
                  {t} SOL
                </option>
              ))}
            </select>
          </label>
          {!armed && (
            <span className="text-[11px] dim">
              Hunts on every page while the app is open. Uses a few hundred KB/s while armed.
            </span>
          )}
        </div>
        {hunting && (
          <div className="num text-[10.5px] faint">
            {hunter.counts.launches} launches · {hunter.counts.tradesSeen.toLocaleString()} trades observed ·{" "}
            {hunter.counts.whales} whales discovered · {hunter.counts.tracked} tracked ·{" "}
            {hunter.counts.journaled} fills journaled · {hunter.counts.signals} signals · {hunter.counts.graded} grades ·{" "}
            {hunter.counts.exits} exits · {hunter.counts.behaviours} behaviour reads this session
          </div>
        )}
        {(hunter.hydrated.wallets > 0 || hunter.hydrated.fills > 0) && (
          <div className="text-[10.5px] dim">
            Resumed with {hunter.hydrated.wallets} tracked wallets and {hunter.hydrated.fills} journaled fills from this
            browser&apos;s own record.
          </div>
        )}
        {armed && (
          <div className="text-[10.5px] dim">
            Coverage: pump.fun bonding-curve trades, program-wide, while this app is open
            {helius.active ? `, plus off-curve trades for the top ${helius.following || "-"} tracked wallets via your Helius key.` : ". Trades on other venues need a Helius key — see Extend coverage below."}
          </div>
        )}
      </div>

      {/* the plan: how big a signal is, in the reader's own terms */}
      <div className="panel p-3.5 flex items-center gap-3 flex-wrap">
        <span className="panel-title">Copy plan</span>
        <label className="num text-[10.5px] faint flex items-center gap-1.5">
          bankroll
          <input
            type="number"
            min="0.1"
            step="0.1"
            inputMode="decimal"
            className="input text-[11px] w-[84px]"
            value={bankrollDraft ?? String(plan.bankrollSol)}
            onChange={(e) => setBankrollDraft(e.target.value)}
            onBlur={commitBankroll}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
            }}
            aria-label="Bankroll in SOL"
          />
          SOL
        </label>
        <label className="num text-[10.5px] faint flex items-center gap-1.5">
          per signal
          <select
            className="input text-[11px]"
            value={plan.riskPct}
            onChange={(e) => setCopyPlan({ ...plan, riskPct: Number(e.target.value) })}
            aria-label="Risk per signal, percent of bankroll"
          >
            {RISK_CHOICES.map((r) => (
              <option key={r} value={r}>
                {r}%
              </option>
            ))}
          </select>
        </label>
        <span className="num text-[11.5px]">
          = <b className="text-[var(--accent)]">{sizeSol} SOL</b> a signal
        </span>
        <label className="num text-[10.5px] faint flex items-center gap-1.5" title="what a round trip costs you: the curve's fee both ways plus priority fees and slippage; every return on the desk is shown net of it">
          round trip costs
          <select
            className="input text-[11px]"
            value={plan.costPct}
            onChange={(e) => setCopyPlan({ ...plan, costPct: Number(e.target.value) })}
            aria-label="Round-trip cost, percent"
          >
            {COST_CHOICES.map((c) => (
              <option key={c} value={c}>
                {c}%
              </option>
            ))}
          </select>
        </label>
        {notif === "default" && (
          <button type="button" className="btn text-[10px]" onClick={() => void requestNotifyPermission()} title="signals and exits will also reach your OS notification center, so a tab you are not looking at still gets through">
            Enable OS notifications
          </button>
        )}
        {notif === "granted" && (
          <span className="chip chip-pos text-[9.5px]" title="signals and exits also reach your OS notification center">
            OS notifications on
          </span>
        )}
        {notif === "denied" && (
          <span className="text-[10px] faint" title="allow notifications for this site in your browser settings to get signals and exits outside the tab">
            OS notifications blocked by the browser
          </span>
        )}
        <span className="text-[10.5px] dim">
          You trade in your own wallet; Nova opens the token where you trade and never holds a key. Exits alert you
          when the signal wallet sells.
        </span>
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
            <span className="panel-title">Signals · proven wallets buying</span>
            <span className="chip text-[9.5px]">{view.signals.length}</span>
          </div>
          <div className="overflow-y-auto max-h-[560px]">
            {view.signals.map((s, i) => {
              const key = s.signal_key ?? signalKeyOf(s);
              const w = walletsByAddr.get(s.wallet_address);
              const hold = w?.median_hold_ms ?? null;
              const exited = typeof s.whale_exit_ret === "number";
              const drafting = followDraft?.key === key;
              const mark = markOf(s.token_address) ?? s.price_at_signal ?? null;
              return (
                <div key={`${key}-${i}`} className="px-3 py-2.5 border-b border-[rgba(27,35,51,0.5)] flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Score value={s.wallet_score} width={44} />
                    <Link href={`/token?m=${s.token_address}`} className="text-[12.5px] font-semibold link">
                      {s.token_name ?? shortAddr(s.token_address)}
                    </Link>
                    <span className="num text-[11px] ml-auto">{s.buy_amount_sol.toFixed(2)} SOL</span>
                  </div>
                  <div className="num text-[10.5px] faint">
                    <Link href={`/whale?a=${s.wallet_address}`} className="link">
                      {shortAddr(s.wallet_address)}
                    </Link>
                    {" · "}
                    {s.settled_sells ? `${s.settled_sells} settled sells` : "settled n/a"}
                    {" · "}
                    {fmtAge(Math.max(0, view.asOf - s.at))} ago
                    {typeof s.price_at_signal === "number" && ` · at ${fmtPriceSol(s.price_at_signal)} SOL`}
                  </div>
                  {/* the grades: what a buyer on the alert was sitting on */}
                  {typeof s.price_at_signal === "number" && (
                    <div className="flex items-center gap-3 flex-wrap">
                      <Grade label="1m" ret={s.ret_1m} title="price at the first trade one minute after the signal, against the signal's fill price" />
                      <Grade label="5m" ret={s.ret_5m} title="five minutes after — the follower return the leaderboard is ranked by" />
                      <Grade label="15m" ret={s.ret_15m} title="fifteen minutes after" />
                      <Grade label="1h" ret={s.ret_1h} title="one hour after" />
                      {typeof s.peak_ret_1h === "number" && (
                        <Grade label="peak" ret={s.peak_ret_1h} title="the best price seen inside the hour — what a perfect exit got, which nobody gets" />
                      )}
                      {s.graded_lookup && (
                        <span className="chip text-[9px]" title="at least one grade came from a DexScreener quote — the token had left the bonding curve, where the stream is blind">
                          dex
                        </span>
                      )}
                      {s.graded_stale && (
                        <span className="chip text-[9px]" title="at least one grade was marked to the last price seen because neither a trade nor a quote landed at that horizon — a quiet or dead token">
                          stale
                        </span>
                      )}
                    </div>
                  )}
                  {/* the wallet's own exit */}
                  <div className="text-[10.5px] num">
                    {exited ? (
                      <span className={retCls(s.whale_exit_ret ?? 0)}>
                        wallet sold {typeof s.whale_exit_fraction === "number" ? `${Math.round(s.whale_exit_fraction * 100)}%` : "some"} at{" "}
                        {fmtRet(s.whale_exit_ret ?? 0)}
                        {typeof s.whale_exit_after_ms === "number" && ` after ${fmtHold(s.whale_exit_after_ms)}`}
                      </span>
                    ) : (
                      <span className="faint">
                        wallet still holding
                        {hold !== null && ` · usually out in ${fmtHold(hold)}`}
                      </span>
                    )}
                  </div>
                  {/* the copy row: size, where to trade it, and the follow */}
                  <div className="flex items-center gap-2 flex-wrap text-[10.5px]">
                    {hold !== null && hold < UNCOPYABLE_HOLD_MS && !exited && (
                      <span className="chip chip-warn text-[9px]" title="this wallet's median hold is under a minute — by the time a person has bought, it has usually sold; a signal from it is information, not an entry">
                        usually out in {fmtHold(hold)} — likely gone before you can buy
                      </span>
                    )}
                    <span className="num dim">
                      plan {sizeSol} SOL
                      {hold !== null && ` · time stop ≈ ${fmtHold(hold)}`}
                    </span>
                    {TRADE_LINKS.map((t) => (
                      <a
                        key={t.label}
                        href={t.href(s.token_address)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="chip text-[9.5px] hover:border-[var(--accent)]"
                        title={`open this token on ${t.label} in a new tab — you trade there, in your own wallet`}
                      >
                        {t.label} ↗
                      </a>
                    ))}
                    {!drafting && !exited && (
                      <button
                        type="button"
                        className="btn text-[10px] ml-auto"
                        onClick={() =>
                          setFollowDraft({
                            key,
                            price: mark !== null ? String(mark) : "",
                            size: String(sizeSol),
                          })
                        }
                      >
                        I followed
                      </button>
                    )}
                  </div>
                  {drafting && followDraft && (
                    <form
                      className="flex items-center gap-2 flex-wrap text-[10.5px] num"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = addFollow({
                          signalKey: key,
                          mint: s.token_address,
                          name: s.token_name,
                          wallet: s.wallet_address,
                          entryPriceSol: Number(followDraft.price),
                          sizeSol: Number(followDraft.size) || 0,
                        });
                        if (f) setFollowDraft(null);
                      }}
                    >
                      <label className="flex items-center gap-1 faint">
                        entry
                        <input
                          className="input text-[10.5px] w-[110px]"
                          value={followDraft.price}
                          onChange={(e) => setFollowDraft({ ...followDraft, price: e.target.value })}
                          inputMode="decimal"
                          aria-label="Entry price, SOL per token"
                          autoFocus
                        />
                        SOL/token
                      </label>
                      <label className="flex items-center gap-1 faint">
                        size
                        <input
                          className="input text-[10.5px] w-[64px]"
                          value={followDraft.size}
                          onChange={(e) => setFollowDraft({ ...followDraft, size: e.target.value })}
                          inputMode="decimal"
                          aria-label="Size in SOL"
                        />
                        SOL
                      </label>
                      <button type="submit" className="btn btn-primary text-[10px]" disabled={!(Number(followDraft.price) > 0)}>
                        Record
                      </button>
                      <button type="button" className="btn text-[10px]" onClick={() => setFollowDraft(null)}>
                        Cancel
                      </button>
                      <span className="faint">prefilled with the last trade the radar saw — type what you actually paid</span>
                    </form>
                  )}
                </div>
              );
            })}
            {view.signals.length === 0 && (
              <div className="px-3 py-8 text-center faint text-[11px] leading-relaxed">
                {feeding && <div className="radar-rings" aria-hidden="true" />}
                {feeding ? (
                  <>
                    No signals yet. A signal needs a wallet that has already proved a 70+ score on settled sells.
                    Snipers flip in minutes, so an armed evening is usually enough for the first proofs — watch the
                    pipeline below fill.
                  </>
                ) : (
                  <>Arm the radar above to start hunting.</>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="panel flex flex-col min-h-[300px]">
          <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
            <span className="panel-title">Top tracked wallets</span>
            <span className="num text-[10px] faint">score = measured fills only</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11.5px]">
              <thead className="thead">
                <tr>
                  <th className="text-left px-3 py-1.5 font-medium">Wallet</th>
                  <th className="text-right px-2 font-medium">Score</th>
                  <th
                    className="text-right px-2 font-medium"
                    title="median of what this wallet's signals were worth five minutes later to a buyer on the alert — whether FOLLOWING it has paid; the count is signals graded"
                  >
                    Follow 5m
                  </th>
                  <th className="text-right px-2 font-medium" title="median time from a buy to its settled sell — how long a copier has before this wallet is out">
                    Hold
                  </th>
                  <th className="text-right px-2 font-medium">Win</th>
                  <th className="text-right px-2 font-medium">PNL SOL</th>
                  <th className="text-right px-3 font-medium" title="sells with a fully observed cost basis / sells the radar refused to score">
                    settled/unm.
                  </th>
                </tr>
              </thead>
              <tbody className="num">
                {view.wallets.map((w) => (
                  <tr key={w.wallet_address} className="trow">
                    <td className="px-3 py-1.5">
                      <Link href={`/whale?a=${w.wallet_address}`} className="link">
                        {shortAddr(w.wallet_address)}
                      </Link>
                      {w.labels.length > 0 && (
                        <div className="flex gap-1 flex-wrap mt-0.5">
                          {w.labels.map((l) => (
                            <span key={l} className={`chip text-[8.5px] ${LABELS[l]?.cls ?? ""}`} title={LABELS[l]?.title}>
                              {l}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td
                      className="text-right px-2"
                      title={`consistency ${w.consistency === null ? "n/a (needs five settled sells)" : w.consistency.toFixed(2)}: mean over spread of per-trade ROI, not annualized. Max drawdown ${w.max_drawdown_sol.toFixed(2)} SOL from the realized high-water mark${w.avg_hold_ms !== null ? `. Mean hold ${fmtHold(w.avg_hold_ms)}` : ""}`}
                    >
                      <Score value={w.score} width={40} />
                    </td>
                    <td className="text-right px-2">
                      {typeof w.follow_ret_5m === "number" ? (
                        <span className={retCls(w.follow_ret_5m)} title={`${w.signals_graded} signal${w.signals_graded === 1 ? "" : "s"} graded${typeof w.follow_hit_rate === "number" ? ` · ${Math.round(w.follow_hit_rate * 100)}% at or above +10%` : ""}`}>
                          {fmtRet(w.follow_ret_5m)}
                          <span className="faint"> ·{w.signals_graded}</span>
                        </span>
                      ) : (
                        <span className="faint" title="no signal from this wallet has been graded yet">—</span>
                      )}
                    </td>
                    <td
                      className={`text-right px-2 ${w.median_hold_ms !== null && w.median_hold_ms < UNCOPYABLE_HOLD_MS ? "warn" : "dim"}`}
                      title={w.median_hold_ms !== null && w.median_hold_ms < UNCOPYABLE_HOLD_MS ? "under a minute: a record nobody can copy" : undefined}
                    >
                      {w.median_hold_ms === null ? "—" : fmtHold(w.median_hold_ms)}
                    </td>
                    <td className="text-right px-2">{(w.win_rate * 100).toFixed(0)}%</td>
                    <td className={`text-right px-2 ${w.realized_pnl >= 0 ? "pos" : "neg"}`}>
                      {w.realized_pnl.toFixed(2)}
                      <div className="text-[9.5px] faint" title="dollars at the live cross-checked SOL price; dd is the deepest fall of realized PNL from its best">
                        {solUsd !== null ? fmtUsd(w.realized_pnl * solUsd) : "—"}
                        {w.max_drawdown_sol > 0 && ` · dd ${w.max_drawdown_sol.toFixed(2)}`}
                      </div>
                    </td>
                    <td className="text-right px-3 dim">
                      {w.settled_sells}/{w.unmeasured_sells}
                    </td>
                  </tr>
                ))}
                {view.wallets.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center faint text-[11px]">
                      {feeding
                        ? "No wallets tracked yet — discoveries land here as whales enter fresh launches."
                        : "Tracked wallets and their measured scores appear here once the radar is armed."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* the reader's own desk */}
      <div className="panel flex flex-col">
        <div className="flex items-center gap-3 px-3 pt-2.5 pb-1.5 flex-wrap">
          <span className="panel-title">Your copy desk</span>
          <span className="num text-[10.5px] faint">
            {openFollows} open
            {record.closed > 0 && (
              <>
                {" · "}
                {record.closed} closed · net of {plan.costPct}% · median{" "}
                <span className={retCls(record.median ?? 0)}>{fmtRet(record.median ?? 0)}</span>
                {" · "}
                {Math.round((record.hitRate ?? 0) * 100)}% at or above +10% ·{" "}
                <span className={record.pnlSol >= 0 ? "pos" : "neg"}>
                  {record.pnlSol >= 0 ? "+" : ""}
                  {record.pnlSol.toFixed(3)} SOL
                </span>{" "}
                at your sizes
              </>
            )}
          </span>
        </div>
        {follows.length === 0 ? (
          <div className="px-3 py-6 text-center faint text-[11px] leading-relaxed">
            Nothing followed yet. Each signal has an <b>I followed</b> button: record what you paid and the desk marks
            it to the last trade the radar sees, tells you when the signal wallet sells, and keeps your closed trades as
            your own record — every number in it is one you typed.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11.5px]">
              <thead className="thead">
                <tr>
                  <th className="text-left px-3 py-1.5 font-medium">Token</th>
                  <th className="text-right px-2 font-medium">Entry</th>
                  <th className="text-right px-2 font-medium" title="open: the last trade the radar saw on this mint; closed: your exit">
                    Mark
                  </th>
                  <th className="text-right px-2 font-medium" title={`net of your ${plan.costPct}% round-trip cost; the gross figure is in the tooltip`}>
                    Net return
                  </th>
                  <th className="text-right px-2 font-medium">SOL</th>
                  <th className="text-left px-2 font-medium">Signal wallet</th>
                  <th className="text-right px-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="num">
                {follows.map((f: Follow) => {
                  const open = f.closedAt === null;
                  const mark = open ? markOf(f.mint) : f.exitPriceSol;
                  const gross = followReturn(f, mark);
                  const ret = followReturnNet(f, mark, plan);
                  const sig = f.signalKey ? signalsByKey.get(f.signalKey) : undefined;
                  const closing = closeDraft?.id === f.id;
                  return (
                    <tr key={f.id} className={`trow ${open ? "" : "opacity-70"}`}>
                      <td className="px-3 py-1.5">
                        <Link href={`/token?m=${f.mint}`} className="link">
                          {f.name ?? shortAddr(f.mint)}
                        </Link>
                        <span className="faint text-[10px]"> {fmtAge(Math.max(0, view.asOf - f.entryAt))} ago</span>
                      </td>
                      <td className="text-right px-2 dim">{fmtPriceSol(f.entryPriceSol)}</td>
                      <td className="text-right px-2 dim" title={open ? (mark !== null ? "last trade the radar saw" : "no trade seen on this mint since you followed — arm the radar, or the token is off the curve") : "your exit"}>
                        {mark !== null ? fmtPriceSol(mark) : "—"}
                      </td>
                      <td className={`text-right px-2 ${ret !== null ? retCls(ret) : "faint"}`} title={gross !== null ? `gross ${fmtRet(gross)}, net of ${plan.costPct}%` : undefined}>
                        {ret !== null ? fmtRet(ret) : "—"}
                      </td>
                      <td className={`text-right px-2 ${ret !== null ? retCls(ret) : "faint"}`}>
                        {ret !== null && f.sizeSol > 0 ? `${ret * f.sizeSol >= 0 ? "+" : ""}${(ret * f.sizeSol).toFixed(3)}` : "—"}
                      </td>
                      <td className="px-2 text-[10.5px]">
                        {sig ? (
                          typeof sig.whale_exit_ret === "number" ? (
                            <span className="warn">
                              sold {typeof sig.whale_exit_fraction === "number" ? `${Math.round(sig.whale_exit_fraction * 100)}%` : ""} at {fmtRet(sig.whale_exit_ret)}
                            </span>
                          ) : (
                            <span className="faint">holding</span>
                          )
                        ) : f.wallet ? (
                          <span className="faint">{shortAddr(f.wallet)}</span>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td className="text-right px-3 whitespace-nowrap">
                        {open ? (
                          closing && closeDraft ? (
                            <form
                              className="inline-flex items-center gap-1.5"
                              onSubmit={(e) => {
                                e.preventDefault();
                                closeFollow(f.id, Number(closeDraft.price));
                                setCloseDraft(null);
                              }}
                            >
                              <input
                                className="input text-[10.5px] w-[100px]"
                                value={closeDraft.price}
                                onChange={(e) => setCloseDraft({ ...closeDraft, price: e.target.value })}
                                inputMode="decimal"
                                aria-label="Exit price, SOL per token"
                                autoFocus
                              />
                              <button type="submit" className="btn btn-primary text-[10px]" disabled={!(Number(closeDraft.price) > 0)}>
                                Close
                              </button>
                              <button type="button" className="btn text-[10px]" onClick={() => setCloseDraft(null)}>
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <button
                              type="button"
                              className="btn text-[10px]"
                              onClick={() => setCloseDraft({ id: f.id, price: mark !== null ? String(mark) : "" })}
                            >
                              Close…
                            </button>
                          )
                        ) : (
                          <button type="button" className="btn text-[10px]" onClick={() => removeFollow(f.id)} title="drop this closed trade from your record">
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* the pipeline filling, and what the tracked wallets are doing */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <div className="panel flex flex-col">
          <div className="px-3 pt-2.5 pb-1.5 panel-title">Behaviour · what tracked wallets are doing</div>
          <div className="overflow-y-auto max-h-[300px]">
            {view.behaviours.map((b, i) => (
              <div key={`${b.wallet}-${b.at}-${i}`} className="px-3 py-1.5 border-b border-[rgba(27,35,51,0.5)] text-[11px] flex flex-col gap-0.5">
                <div className="flex items-center gap-2 num">
                  <span className={`chip text-[8.5px] ${BEHAVIOUR_LABEL[b.behaviour]?.cls ?? ""}`}>{BEHAVIOUR_LABEL[b.behaviour]?.text ?? b.behaviour}</span>
                  <Link href={`/whale?a=${b.wallet}`} className="link">
                    {shortAddr(b.wallet)}
                  </Link>
                  <span className="faint ml-auto">{fmtAge(Math.max(0, view.asOf - b.at))} ago</span>
                </div>
                <div className="dim text-[10.5px] leading-snug">
                  {b.detail}
                  {" · "}
                  <Link href={`/token?m=${b.mint}`} className="link faint">
                    {shortAddr(b.mint)}
                  </Link>
                </div>
              </div>
            ))}
            {view.behaviours.length === 0 && (
              <Waiting hunting={feeding} idle="A dormant wallet waking up big, a position being built or unloaded, a chart being painted." live="Reads fire once at a threshold, a third buy with no sell or a fourth flat leg, so this fills slowly and means it." />
            )}
          </div>
        </div>
        <div className="panel flex flex-col">
          <div className="px-3 pt-2.5 pb-1.5 panel-title">Discoveries · whales entering launches</div>
          <div className="overflow-y-auto max-h-[300px]">
            {view.whales.map((w, i) => (
              <div key={`${w.wallet}-${w.at}-${i}`} className="px-3 py-1.5 border-b border-[rgba(27,35,51,0.5)] num text-[11px] flex items-center gap-2">
                <Link href={`/whale?a=${w.wallet}`} className="link">
                  {shortAddr(w.wallet)}
                </Link>
                <span className="pos">{w.sol.toFixed(1)} SOL</span>
                <span className="minibar" aria-hidden="true">
                  <i style={{ width: `${Math.min(100, (w.sol / maxWhaleSol) * 100)}%` }} />
                </span>
                <Link href={`/token?m=${w.mint}`} className="link faint">
                  {shortAddr(w.mint)}
                </Link>
                <span className="faint ml-auto">
                  {w.launchAgeMs !== null ? `${Math.max(0, Math.round(w.launchAgeMs / 1000))}s post-launch` : ""}
                </span>
              </div>
            ))}
            {view.whales.length === 0 && (
              <Waiting hunting={feeding} idle="Wallets caught entering a launch big." live="Listening — the first whale usually shows within minutes." />
            )}
          </div>
        </div>

        <div className="panel flex flex-col">
          <div className="px-3 pt-2.5 pb-1.5 panel-title">Journal · tracked-wallet fills</div>
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
            {view.trades.length === 0 && (
              <Waiting hunting={feeding} idle="Every later fill by a tracked wallet, the evidence its score rests on." live="Nothing journaled yet — fills follow the first discovery." />
            )}
          </div>
        </div>

        <div className="panel flex flex-col">
          <div className="px-3 pt-2.5 pb-1.5 panel-title">Launches · seen by the radar</div>
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
            {view.launches.length === 0 && (
              <Waiting hunting={feeding} idle="Every pump.fun launch the stream delivers." live="Waiting for the next launch — they arrive every few seconds." />
            )}
          </div>
        </div>
      </div>

      {/* the optional extensions, folded */}
      <details className="panel p-3.5 fold" open={extensionsInUse}>
        <summary>
          <span className="panel-title">Extend coverage · optional</span>
          <span className="text-[11px] dim">
            {helius.keySet ? "Helius key set" : "Helius key for off-curve trades"}
            {" · "}
            {workerUp ? "remote worker connected" : "a remote worker for the hours the app is closed"}
          </span>
        </summary>
        <div className="fold-body">
          <HeliusKeyCard />

          <div className="panel p-3.5 flex flex-col gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="panel-title">Remote worker · optional, for 24/7</span>
              <span className={`chip text-[9.5px] ${workerUp ? "chip-pos" : ""}`}>
                {workerUp ? "CONNECTED" : worker.phase === "connecting" ? "CONNECTING…" : worker.phase === "error" ? "FAILED" : "not connected"}
              </span>
            </div>
            <div className="text-[11.5px] dim leading-relaxed">
              This device stops hunting when the app closes. The repo ships the same engine as a deployable service (
              <a className="link" href="https://github.com/romanstma-cpu/rom-nova/tree/main/worker#readme" target="_blank" rel="noreferrer">
                worker/README
              </a>
              ) that never sleeps; connect yours here and a source toggle appears above to read its feed. ROM runs one — it
              asks for a sign-in, on the{" "}
              <Link href="/account" className="link">
                Account
              </Link>{" "}
              page, which also connects it.
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
                className="input num text-[12px] flex-1 min-w-[240px]"
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
            {worker.gate === "signin" ? (
              <div className="text-[11px] warn">
                This worker asks for a sign-in.{" "}
                <Link href="/account" className="link">
                  Account
                </Link>{" "}
                → sign in, and it connects.
              </div>
            ) : worker.gate === "subscribe" ? (
              <div className="text-[11px] warn">
                This worker&apos;s feed is a subscription.{" "}
                <Link href="/account" className="link">
                  Account
                </Link>{" "}
                → plan.
              </div>
            ) : (
              worker.error && <div className="text-[11px] text-[var(--danger)]">{worker.error}</div>
            )}
          </div>
        </div>
      </details>

      <p className="text-[10px] faint px-1 pb-2 leading-relaxed">
        Radar data is measured by YOUR app (or your worker) from its own observed stream: pump.fun bonding-curve
        trades, program-wide, while armed. Scores stand on settled, fully-observed round trips; grades and exits on
        later trades in the same stream, marked to the last trade seen when a token goes quiet and blind once it leaves
        the curve. The copy desk records what you type and marks it the same way. Signals are observations, not
        advice, nothing here executes trades, and no arrangement of these numbers makes a memecoin a good idea.
      </p>
    </div>
  );
}
