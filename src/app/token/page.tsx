"use client";

// One token, in depth.
//
// This page has two completely different jobs and used to do only one of them.
// Every row in the live scanner links here with a real Solana mint; the handler
// behind it read the simulator's store, which has never heard of one, so every
// one of those links landed on "Token not found". The demo universe still needs
// its own page — paper trading, the similarity study, the synthetic tape — so
// the two live side by side and the payload says which it is.
//
// The live half answers "should I touch this, and why" with the four things a
// price feed cannot tell you: who holds the supply and how much of that is
// labelled, who deployed it and how many times they have done this before,
// whether the authorities and the pool are locked and WHO SAYS SO, and which
// factors the score is missing. Where two sources answer one question
// differently, both answers are printed with their source attached.

import { Suspense, useCallback, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useApi, apiPost, fmtUsd, fmtPct, fmtNum, fmtAge, shortAddr, labelClass } from "@/lib/client";
import { Score, RiskBadge, Skel, TokenMark, Freshness, Empty } from "@/components/ui/bits";
import { PriceChart, type ChartMarker } from "@/components/charts/PriceChart";
import { asChartInterval, NAMED_INTERVALS, type ChartInterval } from "@/lib/providers/jupiter-chart";
import { FlowChart } from "@/components/charts/FlowChart";
import { ForensicsPanel } from "@/components/token/ForensicsPanel";
import { LineChart } from "@/components/charts/LineChart";
import type {
  Candle,
  RiskRadar,
  Signal,
  TokenInfo,
  TokenSnapshot,
  TradeWindowKey,
  UnmeasuredField,
  WalletTrade,
} from "@/lib/types";
import type { FlowPoint } from "@/lib/api/rows";
import type { LiveTokenDetail } from "@/lib/api/detail";
import { WHALE_USD } from "@/lib/engine/live-features";
import type { SimilarityReport } from "@/lib/engine/similarity";
import { NarratedAnswer } from "@/components/ui/NarratedAnswer";
import { subscribeAi, getAiSnapshot, getAiServerSnapshot } from "@/lib/ai/config";

interface DemoTokenDetail {
  mode: "demo";
  info: TokenInfo;
  archetype: string;
  supply: number;
  snapshot: TokenSnapshot;
  signal?: Signal;
  risk?: RiskRadar;
  similar?: SimilarityReport;
  flow: FlowPoint[];
  holdersSeries: { ts: number; holders: number; liquidityUsd: number }[];
  trades: (WalletTrade & { symbol?: string })[];
  topTraders: {
    address: string;
    entity?: string;
    labels: string[];
    smartMoneyScore: number;
    buys: number;
    sells: number;
    netUsd: number;
    unrealizedUsd: number;
    holding: boolean;
  }[];
  asOf: number;
}

type TokenDetail = DemoTokenDetail | LiveTokenDetail;

interface ResearchAnswer {
  answer: string;
  evidence: { label: string; value: string }[];
}

interface CandlePayload {
  candles: Candle[];
  live: { ts: number; price: number } | null;
  provenance?: { source: string; real: boolean; note?: string };
  /** What the bars ARE, measured server-side from their spacing. Null when the
   *  tape is too short or too irregular to name. */
  interval?: ChartInterval | null;
}

/** The one candle subscription, owned above the live/demo split. */
interface CandleHook {
  data: CandlePayload | null;
  error: string | null;
}

/** Where a reader goes to check an address against the chain itself. */
const EXPLORER = "https://solscan.io/account/";

export default function TokenPage() {
  return (
    <Suspense fallback={<Empty>ANALYZING TOKEN…</Empty>}>
      <TokenInner />
    </Suspense>
  );
}

/** Where the reader's granularity choice survives reloads. */
const INTERVAL_KEY = "romnova_chart_interval_v1";

/**
 * First visit defaults to 15-minute bars, not hourly, for two measured
 * reasons. It is the granularity a memecoin question is actually asked at —
 * the reference terminals lead with minutes. And it is served by Jupiter's
 * chart endpoint directly, so the bars do not queue behind GeckoTerminal's
 * 2.1-second serialised slot that the detail assembly is already using:
 * hourly-behind-detail put the first canvas at ~5.4s on a cold load, this
 * path has the bars back before the detail payload lands.
 */
const DEFAULT_INTERVAL: ChartInterval = "15m";

function TokenInner() {
  const mint = useSearchParams().get("m") ?? "";
  // Thirty seconds, not fifteen. A live assembly reaches several providers and
  // pulls a risk report measured up to 1.1MB; `liveTokenDetail` caches for
  // twenty, so a faster poll would re-render the same payload and a slower one
  // would show a stale price.
  const { data, error, loading } = useApi<TokenDetail>(mint ? `/api/tokens/${mint}` : null, 30_000);

  const [chartInterval, setChartIntervalRaw] = useState<ChartInterval>(() => {
    if (typeof localStorage === "undefined") return DEFAULT_INTERVAL;
    try {
      const stored = localStorage.getItem(INTERVAL_KEY);
      return stored ? asChartInterval(stored) : DEFAULT_INTERVAL;
    } catch {
      return DEFAULT_INTERVAL;
    }
  });
  const setChartInterval = useCallback((iv: ChartInterval) => {
    setChartIntervalRaw(iv);
    try {
      localStorage.setItem(INTERVAL_KEY, iv);
    } catch {
      /* private mode — the choice just does not survive the tab */
    }
  }, []);

  // Candles are fetched HERE, not inside LiveToken, so the request leaves in
  // parallel with the detail assembly instead of serialised behind it. The
  // demo tape ticks every 10s; a live one re-polls each minute. A demo mint is
  // pinned to hourly — its tape IS hourly, and asking finer would probe
  // Jupiter with a mint that does not exist on every 10-second poll.
  const effectiveInterval = data?.mode === "demo" ? "1h" : chartInterval;
  const candles = useApi<CandlePayload>(
    mint ? `/api/tokens/${mint}/candles?interval=${effectiveInterval}` : null,
    data?.mode === "demo" ? 10_000 : 60_000,
  );

  // The switcher highlights what is actually PLOTTED, not what was pressed.
  // Derived, not synced: a finer ask that degraded to hourly (or an hourly ask
  // served as 4h bars — see measuredInterval) lights the bucket on screen, and
  // the provenance note explains why it is not the one that was clicked.
  const plottedInterval = candles.data?.interval ?? chartInterval;

  if (!mint || error) {
    return (
      <Empty>
        {/* The message carries the reason from the handler, which distinguishes
            a mint nobody lists from a source that was rate-limited. Rendered
            as-is rather than reworded, because the handler is the only thing
            that knows which of the two happened. */}
        <div className="max-w-[520px] mx-auto leading-relaxed">{error ?? "No mint given."}</div>
        <Link className="link" href="/scanner">
          Back to the scanner.
        </Link>
      </Empty>
    );
  }
  if (!data) {
    if (!loading) return <Empty>NO DATA</Empty>;
    // The detail assembly takes ~2.4s of provider work on a cold load
    // (measured: search → RPC → rugcheck → chain flow). The page's furniture —
    // and usually the finished chart, whose bars come back first — renders
    // through that wait instead of a bare caption.
    return (
      <TokenSkeleton
        candles={candles}
        interval={plottedInterval}
        onInterval={setChartInterval}
      />
    );
  }
  // Branching at a component boundary rather than inside one: the two halves
  // need different hooks, and hooks cannot be called conditionally.
  return data.mode === "live" ? (
    <LiveToken detail={data} candles={candles} interval={plottedInterval} onInterval={setChartInterval} />
  ) : (
    <DemoToken detail={data} mint={mint} candles={candles} />
  );
}

// ---------------------------------------------------------------- chart panel

/** The switcher's order on screen, finest first, like every reference chart. */
const INTERVAL_CHOICES = Object.keys(NAMED_INTERVALS) as ChartInterval[];

/** Time windows a reader can clamp the tape to. Spans, not bar counts, so the
 *  same buttons mean the same thing at every granularity. */
const WINDOW_CHOICES: { label: string; spanMs: number }[] = [
  { label: "1h", spanMs: 3_600_000 },
  { label: "6h", spanMs: 6 * 3_600_000 },
  { label: "24h", spanMs: 86_400_000 },
  { label: "7d", spanMs: 7 * 86_400_000 },
  { label: "all", spanMs: 0 },
];

/**
 * The price panel: interval switcher, window clamp, log axis, provenance chip.
 *
 * The caption prints the PAYLOAD's measured interval, never the button that
 * was pressed — the two differ whenever a finer ask degraded (the switcher
 * snaps back a beat later, see TokenInner) — and the shimmer state is a blank
 * block: a placeholder chart with invented bars would be the forbidden
 * rendering, in the panel where it would do the most damage.
 */
function ChartPanel({
  candles,
  interval,
  onInterval,
  markers = [],
  freshTs,
  children,
}: {
  candles: CandleHook;
  interval: ChartInterval;
  onInterval: (iv: ChartInterval) => void;
  markers?: ChartMarker[];
  freshTs?: number;
  children?: React.ReactNode;
}) {
  const [logScale, setLogScale] = useState(false);
  const [spanMs, setSpanMs] = useState(0);
  const payload = candles.data;

  const shown = useMemo(() => {
    const all = payload?.candles ?? [];
    if (spanMs === 0 || all.length === 0) return all;
    const cutoff = all[all.length - 1].t - spanMs;
    return all.filter((c) => c.t >= cutoff);
  }, [payload, spanMs]);

  // A 7d button over ~115 hourly bars (~4.8d of history) stayed lit and
  // silently showed less than it promised. The button is an ask; when the
  // source's history starts inside the window, the shortfall gets a sentence.
  const shortfallDays = useMemo(() => {
    const all = payload?.candles ?? [];
    if (spanMs === 0 || all.length < 2) return null;
    const covered = all[all.length - 1].t - all[0].t;
    if (covered >= spanMs) return null;
    return covered / 86_400_000;
  }, [payload, spanMs]);

  return (
    <div className="panel">
      <div className="flex items-center justify-between px-3 pt-2.5 gap-2 flex-wrap">
        <span className="panel-title">
          Price
          {payload?.interval ? (
            <span> · {payload.interval} bars</span>
          ) : payload && payload.candles.length > 0 && payload.candles.length < 3 ? (
            // Too few steps to measure a spacing. Naming the requested bucket
            // here would caption an ask, not a measurement — so the caption
            // says what it counted instead of going silently mute.
            <span>
              {" "}
              · {payload.candles.length} bar{payload.candles.length === 1 ? "" : "s"} — too few to
              measure a granularity
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-0.5" role="group" aria-label="bar interval">
            {INTERVAL_CHOICES.map((iv) => (
              <button
                key={iv}
                className={`btn text-[10px] px-1.5 py-0.5 ${interval === iv ? "btn-primary" : ""}`}
                onClick={() => onInterval(iv)}
                title={`${iv} bars`}
              >
                {iv}
              </button>
            ))}
          </span>
          <span className="w-px h-[14px] bg-[var(--border)]" aria-hidden="true" />
          <span className="flex items-center gap-0.5" role="group" aria-label="time window">
            {WINDOW_CHOICES.map((w) => (
              <button
                key={w.label}
                className={`btn text-[10px] px-1.5 py-0.5 ${spanMs === w.spanMs ? "btn-primary" : ""}`}
                onClick={() => setSpanMs(w.spanMs)}
              >
                {w.label}
              </button>
            ))}
          </span>
          <button
            className={`btn text-[10px] px-1.5 py-0.5 ${logScale ? "btn-primary" : ""}`}
            onClick={() => setLogScale((x) => !x)}
            title="logarithmic price axis"
          >
            log
          </button>
          {/* A dead chart must not wear a live chip. During a candle failure
              the previous payload's source and "updated Ns ago" kept rendering
              beside a body reporting the outage — two adjacent claims about the
              same panel, one of them false. */}
          {payload?.provenance && !candles.error && (
            <span
              className={`chip ${payload.provenance.real ? "chip-accent" : "chip-warn"}`}
              title={payload.provenance.note ?? "real market data"}
            >
              {payload.provenance.real ? payload.provenance.source.toUpperCase() : "SIMULATED"}
            </span>
          )}
          {freshTs !== undefined && !candles.error && <Freshness ts={freshTs} />}
        </span>
      </div>
      <div className="px-2 pb-2">
        {candles.error ? (
          <div className="h-[340px] flex items-center justify-center faint text-[11px] px-8 text-center leading-relaxed">
            No price history for this mint — {candles.error}. The rest of this page does not
            depend on it: the score never read these bars.
          </div>
        ) : payload ? (
          shown.length > 0 ? (
            <>
              <PriceChart candles={shown} markers={markers} height={340} logScale={logScale} />
              {shortfallDays !== null && (
                <div className="px-1 pt-1 text-[9.5px] faint">
                  the source&rsquo;s history covers {shortfallDays.toFixed(1)} days — less than the
                  window selected
                </div>
              )}
            </>
          ) : (
            <div className="h-[340px] flex items-center justify-center faint text-[11px] px-8 text-center">
              No bars in this range. {payload.provenance?.note ?? "The history source returned nothing."}
            </div>
          )
        ) : (
          <div className="h-[340px] pt-2">
            <span className="skel" style={{ width: "100%", height: "100%" }} aria-label="loading price history" />
          </div>
        )}
      </div>
      {children && <div className="px-3 pb-2 text-[10px] faint leading-snug">{children}</div>}
    </div>
  );
}

/**
 * The page while the detail assembly is still out. Structure and shimmer only —
 * except the chart, which renders REAL bars the moment its (parallel, faster)
 * fetch lands. Nothing here prints a number nobody measured.
 */
function TokenSkeleton({
  candles,
  interval,
  onInterval,
}: {
  candles: CandleHook;
  interval: ChartInterval;
  onInterval: (iv: ChartInterval) => void;
}) {
  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="panel px-4 py-3 flex items-center gap-4 flex-wrap">
        <Skel w={38} h={38} round />
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-2">
            <Skel w={72} h={14} />
            <Skel w={120} />
          </span>
          <Skel w={300} h={8} />
        </div>
        <div className="flex items-center gap-5 ml-auto">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className="flex flex-col gap-1.5 items-end">
              <Skel w={40} h={7} />
              <Skel w={56} h={12} />
            </span>
          ))}
        </div>
        <span className="w-full text-[10px] faint">
          ANALYZING TOKEN — reading the mint account, holder set, risk report and recent chain flow…
        </span>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-3">
        <ChartPanel candles={candles} interval={interval} onInterval={onInterval} />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="panel p-3 flex flex-col gap-2.5">
              <Skel w={110} h={8} />
              <Skel w={230} />
              <Skel w={180} />
              <Skel w={210} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- live token

function LiveToken({
  detail,
  candles,
  interval,
  onInterval,
}: {
  detail: LiveTokenDetail;
  candles: CandleHook;
  interval: ChartInterval;
  onInterval: (iv: ChartInterval) => void;
}) {
  const d = detail;
  const { info, snapshot: snap, signal, risk } = d;
  const [copied, setCopied] = useState(false);

  // The wallets that actually moved size, on the chart — placed on the newest
  // bar, which every window slice keeps, so this can be computed against the
  // full tape.
  const markers = useMemo<ChartMarker[]>(() => {
    const movers = d.flow?.movers ?? [];
    const all = candles.data?.candles ?? [];
    if (!movers.length || all.length === 0) return [];
    const at = all[all.length - 1].t;
    return movers
      .filter((m) => Math.abs(m.usd) >= 5_000)
      .slice(0, 12)
      .map((m) => ({
        ts: at,
        kind: m.usd >= 0 ? ("whale_buy" as const) : ("whale_sell" as const),
        text: `${m.usd >= 0 ? "▲" : "▼"} ${fmtUsd(Math.abs(m.usd))}`,
      }));
  }, [d.flow, candles.data]);

  const unmeasured = snap.unmeasured ?? [];
  const absent = (f: UnmeasuredField) => unmeasured.includes(f);

  return (
    <div className="p-3 flex flex-col gap-3">
      {/* header */}
      <div className="panel px-4 py-3 flex items-center gap-4 flex-wrap">
        <TokenMark hue={info.hue} symbol={info.symbol} size={38} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[17px] font-semibold">{info.symbol}</span>
            <span className="dim text-[13px]">{info.name}</span>
            {info.verified && <span className="chip chip-accent">verified</span>}
            {d.creator.launchpad && <span className="chip">{d.creator.launchpad}</span>}
            <span className="chip" title={new Date(info.createdAt).toISOString()}>
              {fmtAge(d.asOf - info.createdAt)} old
            </span>
            <span className="chip chip-accent" title={`market data from ${d.source}`}>
              {d.source.toUpperCase()}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <button
              className="num text-[10.5px] faint hover:text-[var(--accent)]"
              onClick={() => {
                navigator.clipboard?.writeText(info.mint);
                setCopied(true);
              }}
              title="copy mint address"
            >
              {info.mint} {copied ? "copied" : "⧉"}
            </button>
            <a
              className="link text-[10.5px]"
              href={`${EXPLORER}${info.mint}`}
              target="_blank"
              rel="noreferrer"
            >
              explorer ↗
            </a>
            {/* Not a safety signal — anybody can put a link in token metadata —
                but a memecoin with no site, no X and no group is a different
                object from one with all three, and every reference terminal
                shows them. */}
            {LINK_KINDS.map(([key, label]) => {
              const href = info.links?.[key];
              return href ? (
                <a key={key} className="link text-[10.5px]" href={href} target="_blank" rel="noreferrer">
                  {label} ↗
                </a>
              ) : null;
            })}
            {!info.links && (
              <span className="faint text-[10.5px]" title={`${d.source} carried no website, X or Telegram for this mint`}>
                no socials listed
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-5 ml-auto num text-[13px] flex-wrap">
          <HeaderStat label="Price">{fmtUsd(snap.priceUsd)}</HeaderStat>
          {/* The four windows every reference terminal leads with. This page
              opened on Price/Mcap/Liquidity and made a reader hunt the chart for
              the single most-glanced-at number on a token screen. */}
          <ChangeStrip snap={snap} source={d.source} />
          <HeaderStat label="Mcap">{fmtUsd(snap.marketCapUsd)}</HeaderStat>
          {/* FDV was in the payload from the first live provider and shown
              nowhere. Beside Mcap, because the two only differ when supply is
              still unlocked and that gap is the whole point of printing it. */}
          <HeaderStat label="FDV">
            {d.supply.fdvUsd === undefined ? (
              <Dash why={`${d.source} published no fully-diluted valuation`} />
            ) : (
              <span
                title={
                  d.supply.mcapToFdv === undefined
                    ? undefined
                    : `market cap is ${(d.supply.mcapToFdv * 100).toFixed(0)}% of FDV — the rest of the supply is not circulating yet`
                }
              >
                {fmtUsd(d.supply.fdvUsd)}
              </span>
            )}
          </HeaderStat>
          <HeaderStat label="Liquidity">
            {/* Liquidity over market cap, on the number it qualifies. A $40M cap
                over a $90k pool is not a price anyone gets out at, and that is
                invisible when the two figures merely sit side by side. */}
            <span
              title={
                d.supply.liqToMcap === undefined
                  ? undefined
                  : `${(d.supply.liqToMcap * 100).toFixed(2)}% of market cap is actually pooled`
              }
            >
              {fmtUsd(snap.liquidityUsd)}
              {d.supply.liqToMcap !== undefined && (
                <span className={d.supply.liqToMcap < 0.01 ? "warn" : "faint"}>
                  {" "}
                  ({(d.supply.liqToMcap * 100).toFixed(1)}%)
                </span>
              )}
            </span>
          </HeaderStat>
          <HeaderStat label="24h vol">{fmtUsd(snap.volume24hUsd)}</HeaderStat>
          <HeaderStat label="Holders">
            {absent("holders") ? (
              <Dash why={`${d.source} did not publish a holder count for this mint`} />
            ) : (
              <span title={`${d.source}'s count`}>{fmtNum(snap.holders)}</span>
            )}
          </HeaderStat>
          <HeaderStat label={`Signal · ${signal.profile}`}>
            <span className="flex items-center gap-2">
              <Score value={signal.score} width={50} />
              <span className={`chip ${labelClass(signal.label)}`}>{signal.label}</span>
            </span>
          </HeaderStat>
          {/* The vendor's grade, in its own box, higher-is-worse, named. Folding
              it into the score would launder somebody else's judgement as Nova's. */}
          <HeaderStat label={risk ? `${risk.source} risk` : "3rd-party risk"}>
            {risk ? (
              <span
                className={risk.score >= 40 ? "neg" : risk.score >= 15 ? "warn" : "pos"}
                title={`${risk.source} rates this ${risk.score}/100 — HIGHER IS RISKIER, the inverse of the signal beside it. Not an input to Nova's score.`}
              >
                {risk.score}/100
              </span>
            ) : (
              <Dash why="no risk provider graded this mint" />
            )}
          </HeaderStat>
        </div>
      </div>

      {/* The verdict's own headline, above everything. A score of 35 beside a
          green bar meant nothing until the label could be vetoed; now that it
          can, the reason for the veto is the first thing on the page. */}
      {signal.securityVeto && (
        <div className="panel p-3 border-l-2" style={{ borderLeftColor: "var(--neg)" }}>
          <div className="text-[13px] neg font-semibold">EXTREME RISK — {signal.securityVeto}</div>
          <div className="text-[11px] faint mt-1 leading-snug">
            This is a veto on the verdict, not a weight in it. The score below is still the honest
            weighted mean of everything that was measured; no amount of liquidity, momentum or
            organic activity is allowed to label this token positive while that is true.
          </div>
        </div>
      )}
      {signal.noTradeReason && !signal.securityVeto && (
        <div className="panel p-3 border-l-2" style={{ borderLeftColor: "var(--warn)" }}>
          <div className="text-[12.5px] warn font-semibold">NO TRADE — {signal.noTradeReason}</div>
          <div className="text-[11px] faint mt-1 leading-snug">
            The engine is allowed to abstain, and this is an abstention rather than a verdict: it
            says the evidence was not there, not that the token is bad.
          </div>
        </div>
      )}
      {/* The middle rung: not a veto, not a penalty. The score below stands as
          the honest weighted mean; the LABEL is held at WATCH. */}
      {signal.labelCap && !signal.securityVeto && !signal.noTradeReason && (
        <div className="panel p-3 border-l-2" style={{ borderLeftColor: "var(--warn)" }}>
          <div className="text-[12.5px] warn font-semibold">
            HELD AT WATCH — {signal.labelCap}
          </div>
          <div className="text-[11px] faint mt-1 leading-snug">
            This is a cap on the verdict rather than a disqualification. A live mint authority is a
            capability and vetoes outright; a deployer&rsquo;s launch count is a base rate, so it
            caps instead. The score beside the label is unchanged — it is what the measured factors
            add up to, and it is not fudged to agree with the cap.
          </div>
        </div>
      )}
      {d.disagreements.length > 0 && <Disagreements items={d.disagreements} />}

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-3">
        <div className="flex flex-col gap-3 min-w-0">
          {/* chart */}
          <ChartPanel candles={candles} interval={interval} onInterval={onInterval} markers={markers} freshTs={snap.ts}>
            Markers are the wallets in the flow panel below, placed on the newest bar — the flow
            window is ten minutes, not the life of the chart, so they say <b>who moved recently</b>,
            not when. The score above does not read these bars: with no candles in its vector it
            takes momentum from {d.source}&rsquo;s published 1h and 24h change, which the audit
            names.
          </ChartPanel>

          <ActivityPanel detail={d} />
          <ScoreAuditPanel detail={d} />
          <HolderPanel detail={d} />
          <FlowPanelView detail={d} />
        </div>

        <div className="flex flex-col gap-3">
          <SecurityPanel detail={d} />
          <CreatorCard detail={d} />
          <ForensicsPanel mint={info.mint} createdAt={info.createdAt} asOf={d.asOf} />

          {/* why / bear / invalidation */}
          <div className="panel p-3">
            <div className="panel-title">Signal · {signal.kind.replace(/_/g, " ")}</div>
            <div className="mt-2.5">
              <div className="text-[10.5px] pos font-semibold tracking-wide mb-1">WHY</div>
              {signal.why.map((w, i) => (
                <div key={i} className="text-[11.5px] dim leading-snug mb-0.5">
                  · {w}
                </div>
              ))}
              <div className="text-[10.5px] neg font-semibold tracking-wide mt-2 mb-1">
                WHAT COULD MAKE THIS FAIL
              </div>
              {signal.bearCase.slice(0, 5).map((w, i) => (
                <div key={i} className="text-[11.5px] dim leading-snug mb-0.5">
                  · {w}
                </div>
              ))}
              <div className="text-[10.5px] warn font-semibold tracking-wide mt-2 mb-1">INVALIDATION</div>
              {signal.invalidation.slice(0, 3).map((w, i) => (
                <div key={i} className="text-[11.5px] dim leading-snug mb-0.5">
                  · {w}
                </div>
              ))}
            </div>
          </div>

          <ProvenancePanel lines={d.provenance} asOf={d.asOf} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- live panels

/**
 * TXNS / BUYS / SELLS / MAKERS per window.
 *
 * The block DEX Screener and Photon lead their token pages with, and the one
 * this page did not have — `buys1h` and `sells1h` were already in the feature
 * vector, surfaced only as a derived "buy/sell imbalance %" buried in an audit
 * row. A reader who wants to know whether anyone is actually trading a token
 * should not have to reverse a percentage to find out.
 *
 * Every cell renders a dash when the source did not break that window out, on
 * the same rule as the price strip: a quiet window and an unfetched one look
 * identical unless the panel refuses to print a zero it was not given.
 */
function ActivityPanel({ detail }: { detail: LiveTokenDetail }) {
  const w = detail.snapshot.windows;
  if (!w) {
    return (
      <div className="panel p-3">
        <div className="panel-title mb-1">Activity</div>
        <div className="text-[11.5px] faint leading-snug">
          {detail.source} publishes no per-window trade breakdown for this mint. That is an absence,
          not a quiet tape.
        </div>
      </div>
    );
  }
  const keys: TradeWindowKey[] = ["5m", "1h", "6h", "24h"];
  const shown = keys.filter((k) => w[k]);
  return (
    <div className="panel">
      <div className="flex items-center justify-between px-3 pt-2.5 gap-2 flex-wrap">
        <span className="panel-title">Activity · buys, sells and who made them</span>
        <span className="num text-[10.5px] faint">{detail.source}</span>
      </div>
      <table className="w-full text-[11.5px]">
        <thead className="thead">
          <tr>
            <th className="text-left px-3 py-1.5 font-medium">Window</th>
            <th className="text-right px-2 font-medium">Txns</th>
            <th className="text-right px-2 font-medium">Buys</th>
            <th className="text-right px-2 font-medium">Sells</th>
            <th className="text-right px-2 font-medium">Makers</th>
            <th className="text-right px-3 font-medium">Buy / sell volume</th>
          </tr>
        </thead>
        <tbody className="num">
          {shown.map((k) => {
            const row = w[k]!;
            const txns =
              row.buys === undefined && row.sells === undefined
                ? undefined
                : (row.buys ?? 0) + (row.sells ?? 0);
            return (
              <tr key={k} className="trow">
                <td className="px-3 py-1 dim">{k}</td>
                <td className="text-right px-2 dim">
                  {txns === undefined ? <Dash why="neither side was published" /> : fmtNum(txns)}
                </td>
                <td className="text-right px-2 pos">
                  {row.buys === undefined ? <Dash why="not published" /> : fmtNum(row.buys)}
                </td>
                <td className="text-right px-2 neg">
                  {row.sells === undefined ? <Dash why="not published" /> : fmtNum(row.sells)}
                </td>
                <td className="text-right px-2 dim">
                  {row.traders === undefined ? (
                    <Dash why={`${detail.source} counts transactions, not distinct wallets, for this window`} />
                  ) : (
                    fmtNum(row.traders)
                  )}
                </td>
                <td className="text-right px-3">
                  {row.buyVolumeUsd === undefined || row.sellVolumeUsd === undefined ? (
                    <Dash why={`${detail.source} publishes volume for this window but not the buy/sell split`} />
                  ) : (
                    <>
                      <span className="pos">{fmtUsd(row.buyVolumeUsd)}</span>
                      <span className="faint"> / </span>
                      <span className="neg">{fmtUsd(row.sellVolumeUsd)}</span>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="px-3 py-1.5 text-[10.5px] faint leading-snug">
        Counts are transactions, not wallets, except under <b>Makers</b> — which is distinct traders
        where the source counts them and a dash where it does not. Buys plus sells is not a maker
        count: one wallet that did both would be counted twice.
      </div>
    </div>
  );
}

function ScoreAuditPanel({ detail }: { detail: LiveTokenDetail }) {
  const { signal, audit } = detail;
  const stood = audit.rows.filter((r) => !r.measured);
  return (
    <div className="panel">
      <div className="flex items-center justify-between px-3 pt-2.5 gap-2 flex-wrap">
        <span className="panel-title">The score, every factor</span>
        {/* Confidence is a PRODUCT, and reporting only the product made it look
            like a constant — 77% on eight of twelve mints reviewed. Both terms
            are printed so a reader can see which one is binding: on live tokens
            it is almost always coverage. */}
        <span
          className="num text-[10.5px] faint"
          title="confidence = evidence quality x coverage. Evidence quality is the tape behind the vector — sample size, staleness, age, depth. Coverage is how much of the model had anything to read."
        >
          confidence {(signal.confidence * 100).toFixed(0)}% ={" "}
          {(audit.evidenceQuality * 100).toFixed(0)}% evidence ×{" "}
          {(audit.coverage * 100).toFixed(0)}% coverage
        </span>
      </div>
      <div className="px-3 pt-1 pb-1.5 text-[10.5px] faint leading-snug">
        Contribution is signed points on the 0-100 scale, measured from the neutral 50 — so a factor
        sitting exactly at its midpoint contributes <b>nothing</b> rather than paying credit for the
        absence of what it measures. A factor that <b>stood down</b> left the weighted mean entirely
        rather than scoring its missing input as a zero, and the confidence above fell by its
        weight — {audit.missingWeight.toFixed(1)} of weight went unused and {audit.unmeasuredRisks}{" "}
        risk factor{audit.unmeasuredRisks === 1 ? "" : "s"} could not be assessed at all. These rows
        sum to {audit.reconciled} against a score of {signal.score}.
      </div>
      <table className="w-full text-[11.5px]">
        <thead className="thead">
          <tr>
            <th className="text-left px-3 py-1.5 font-medium">Factor</th>
            <th className="text-right px-2 font-medium">Weight</th>
            <th className="text-left px-2 font-medium w-[120px]">Reading</th>
            <th className="text-right px-2 font-medium">Points</th>
            <th className="text-left px-3 font-medium">What it saw</th>
          </tr>
        </thead>
        <tbody className="num">
          {audit.rows.map((r) => (
            <tr key={r.key} className="trow">
              <td className={`px-3 py-1 ${r.measured ? "" : "faint"}`} style={{ fontFamily: "var(--font-sans)" }}>
                {r.name}
                {r.kind === "risk" && <span className="faint text-[9.5px] ml-1.5">penalty</span>}
              </td>
              <td className={`text-right px-2 ${r.measured ? "dim" : "faint line-through"}`}>
                {r.intendedWeight.toFixed(1)}
              </td>
              <td className="px-2">
                {r.measured ? (
                  // Risk rows store `normalized` as 1 - severity, so a full bar
                  // means clean. Flipped here so the bar always reads "more is
                  // worse" in the penalty rows and "more is better" above them
                  // would be a silent sign flip in the same column.
                  <Bar value={r.kind === "risk" ? 1 - r.normalized : r.normalized} bad={r.kind === "risk"} />
                ) : (
                  <span className="faint text-[10px]">stood down</span>
                )}
              </td>
              {/* A risk row's points can only ever be zero or negative, so a
                  leading "+" on its zero reads as a bonus. Signed only where a
                  sign is meaningful. */}
              <td
                className={`text-right px-2 ${
                  !r.measured ? "faint" : r.contribution > 0 ? "pos" : r.contribution < 0 ? "neg" : "dim"
                }`}
              >
                {!r.measured ? "—" : points(r.contribution, r.kind === "risk")}
              </td>
              <td className={`px-3 ${r.measured ? "dim" : "faint"}`} style={{ fontFamily: "var(--font-sans)" }}>
                {r.explanation}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* When a veto is present this is NOT the verdict, and must not be printed
          as one — the header chip says EXTREME RISK and a bold "NO TRADE" here
          would put a second answer to one question on the same screen. The
          abstention is still worth showing; it is demoted to what it is. */}
      {signal.noTradeReason && (
        <div className="px-3 py-2 border-t border-[var(--border)] text-[11.5px] warn leading-snug">
          <b>{signal.securityVeto ? "Also abstained" : "NO TRADE"}</b> — {signal.noTradeReason}.{" "}
          {signal.securityVeto
            ? "The verdict above is the security veto, which outranks this: it is a finding, and an abstention is the absence of one."
            : "The engine is allowed to abstain, and"}{" "}
          {stood.length > 0
            ? `${stood.length} factor${stood.length === 1 ? "" : "s"} (${stood.map((s) => s.name).join(", ")}) had nothing to read.`
            : "this one is a gate rather than a data gap."}
        </div>
      )}
    </div>
  );
}

function HolderPanel({ detail }: { detail: LiveTokenDetail }) {
  const h = detail.holders;
  if (h.rows.length === 0) {
    return (
      <div className="panel p-3">
        <div className="panel-title mb-1">Top holders</div>
        <div className="text-[11.5px] faint leading-snug">
          No holder table published for this mint. That is an absence, not a flat cap table — nobody
          here has looked at who holds the supply.
        </div>
      </div>
    );
  }
  // Precomputed rather than accumulated inside the map: a running total mutated
  // during render is exactly the pattern the compiler rejects, and it would go
  // wrong the moment the list re-rendered without remounting.
  const cumulative = h.rows.reduce<number[]>((acc, r, i) => {
    acc.push((acc[i - 1] ?? 0) + r.pct);
    return acc;
  }, []);
  return (
    <div className="panel">
      <div className="flex items-center justify-between px-3 pt-2.5 gap-2 flex-wrap">
        <span className="panel-title">Top {h.rows.length} holders · published by {h.source}</span>
        <span className="num text-[10.5px] faint">
          {h.totalHolders !== undefined ? `${h.totalHolders.toLocaleString()} holders in total` : ""}
        </span>
      </div>
      {/* The coverage line is the panel's most important sentence. A table of
          twenty rows with two names invites the reading that the other eighteen
          are wallets; most of them are pools and program accounts nobody
          labelled. */}
      <div className="px-3 pt-1 pb-1.5 text-[10.5px] faint leading-snug">
        <b className={h.labelled === 0 ? "warn" : ""}>
          {h.labelled} of {h.rows.length} rows carry a label
        </b>{" "}
        from {h.source}. The rest are unidentified: an AMM pool, a staking vault and a whale look
        identical here. Nova does <b>not</b> compute a &ldquo;concentration excluding pools&rdquo;
        figure from this — measured across ten trending tokens, 12 of 200 rows were labelled, so that
        number would be most wrong on the largest tokens. These {h.rows.length} rows sum to{" "}
        <span className="num">{(h.listedPct * 100).toFixed(1)}%</span> of supply.
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full text-[11.5px]">
          <thead className="thead sticky top-0 bg-[var(--panel-solid)] z-10">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium w-8">#</th>
              <th className="text-left px-2 font-medium">Owner</th>
              <th className="text-left px-2 font-medium">Label</th>
              <th className="text-right px-2 font-medium">Share</th>
              <th className="text-right px-3 font-medium">Cumulative</th>
            </tr>
          </thead>
          <tbody className="num">
            {h.rows.map((r, i) => {
              return (
                <tr key={`${r.rank}-${r.owner}`} className="trow">
                  <td className="px-3 py-1 faint">{r.rank}</td>
                  <td className="px-2">
                    <AddressLinks owner={r.owner} account={r.account} />
                  </td>
                  <td className="px-2">
                    {r.isCreator && <span className="chip chip-neg mr-1">deployer</span>}
                    {r.insider && <span className="chip chip-warn mr-1">insider</span>}
                    {r.label ? (
                      <span className="dim">{r.label}</span>
                    ) : !r.isCreator && !r.insider ? (
                      <span className="faint" title={`${h.source} has no name for this account`}>
                        unlabelled
                      </span>
                    ) : null}
                  </td>
                  <td className={`text-right px-2 ${r.pct >= 0.1 ? "warn" : "dim"}`}>
                    {(r.pct * 100).toFixed(2)}%
                  </td>
                  <td className="text-right px-3 faint">{(cumulative[i] * 100).toFixed(1)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FlowPanelView({ detail }: { detail: LiveTokenDetail }) {
  const f = detail.flow;
  if (!f) {
    return (
      <div className="panel p-3">
        <div className="panel-title mb-1">Live flow</div>
        <div className="text-[11.5px] faint leading-snug">
          No wallet-flow source answered. Whale flow is <b>unmeasured</b> — which is why the Whale
          Accumulation factor stood down above, and is not the same as nobody trading.
        </div>
      </div>
    );
  }
  const net = f.movers.reduce((s, m) => s + m.usd, 0);
  return (
    <div className="panel">
      <div className="flex items-center justify-between px-3 pt-2.5 gap-2 flex-wrap">
        <span className="panel-title">Live flow · who moved it, on chain</span>
        <span className="num text-[10.5px] faint">{f.source} · {f.megabytesRead.toFixed(1)}MB read</span>
      </div>
      {/* The window ACTUALLY covered, never the one requested. A byte budget
          that stopped at four minutes must not be printed as ten. */}
      <div className="px-3 pt-1 pb-1.5 text-[10.5px] faint leading-snug">
        {f.minutesCovered.toFixed(1)} of {f.minutesRequested} minutes of chain
        {f.complete ? "" : " — byte budget reached, window truncated"} ·{" "}
        <span className="num">{f.movements}</span> balance changes across{" "}
        <span className="num">{f.wallets}</span> wallets ({f.buyers} accumulating, {f.sellers}{" "}
        distributing
        {/* The remainder is real and would otherwise read as a counting error:
            a wallet that bought and sold back to flat inside the window is
            neither side, but it did move. */}
        {f.wallets - f.buyers - f.sellers > 0 ? `, ${f.wallets - f.buyers - f.sellers} round-tripped to flat` : ""}
        ) · <span className="num">{f.touchedNotMoved}</span> rows were accounts merely
        touched by a transaction and discarded. Pool vaults, program authorities and the burn
        address are not counted or listed — the pool side of a swap moves size by definition.
        Every address below is real and checkable.
      </div>
      <div className="max-h-[300px] overflow-y-auto">
        <table className="w-full text-[11.5px]">
          <thead className="thead sticky top-0 bg-[var(--panel-solid)] z-10">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">Wallet</th>
              <th className="text-left px-2 font-medium">Side</th>
              <th className="text-right px-2 font-medium">Net tokens</th>
              <th className="text-right px-3 font-medium">Net USD</th>
            </tr>
          </thead>
          <tbody className="num">
            {f.movers.map((m) => (
              <tr key={m.owner} className="trow">
                <td className="px-3 py-1">
                  <AddressLinks owner={m.owner} />
                </td>
                <td className={`px-2 ${m.usd >= 0 ? "pos" : "neg"}`}>{m.usd >= 0 ? "BUY" : "SELL"}</td>
                <td className="text-right px-2 dim">{fmtNum(Math.abs(m.tokens))}</td>
                <td className={`text-right px-3 ${m.usd >= 0 ? "pos" : "neg"}`}>{fmtUsd(m.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {f.movers.length === 0 && (
          <Empty>Nothing moved more than a dollar in the window that was covered.</Empty>
        )}
      </div>
      {f.movers.length > 0 && (
        <div className="px-3 py-1.5 border-t border-[var(--border)] text-[10.5px] faint num">
          Listed wallets net <span className={net >= 0 ? "pos" : "neg"}>{fmtUsd(net)}</span> over the
          covered window. This is the top of the mover list, not the whole book — and{" "}
          {/* Stated because the audit above says "no whale-sized trades" on
              tokens whose flow table is plainly full of trades. The two agree;
              the threshold is what makes them agree. */}
          the Whale Accumulation factor counts only moves of {fmtUsd(WHALE_USD)} or more, so a busy
          table here and a quiet whale factor above are consistent.
        </div>
      )}
    </div>
  );
}

function SecurityPanel({ detail }: { detail: LiveTokenDetail }) {
  const { info, risk, authorityChecked, authoritySource, source } = detail;
  const dangers = risk?.risks.filter((r) => r.level === "danger") ?? [];
  const warns = risk?.risks.filter((r) => r.level === "warn") ?? [];
  return (
    <div className="panel p-3">
      <div className="panel-title mb-2">Security · who says so</div>

      {/* The unverified wording used to claim the score "graded it as live".
          Nothing graded it — the authorities were not in the feature vector at
          all. They are now, and the true statement is the one below: the
          factors stand down and the engine abstains, which is neither treating
          the token as safe nor asserting a danger nobody established. */}
      <Attributed
        ok={info.mintAuthorityRevoked}
        verified={authorityChecked}
        by={authorityChecked ? (authoritySource ?? "chain") : source}
        okText="Mint authority revoked — supply is fixed"
        badText="Mint authority LIVE — supply can be inflated"
        unverifiedText="Mint authority UNVERIFIED — nobody could read the mint account, so the Mint Authority factor stands down and the engine abstains"
      />
      <Attributed
        ok={info.freezeAuthorityRevoked}
        verified={authorityChecked}
        by={authorityChecked ? (authoritySource ?? "chain") : source}
        okText="Freeze authority revoked"
        badText="Freeze authority LIVE — balances can be frozen"
        unverifiedText="Freeze authority UNVERIFIED — same read, same stand-down"
      />

      {risk?.permanentDelegate !== undefined && (
        <Attributed
          ok={risk.permanentDelegate === null}
          verified
          by={risk.source}
          okText="No permanent delegate"
          badText={`Permanent delegate SET (${shortAddr(risk.permanentDelegate ?? "")}) — that key can move any balance`}
          unverifiedText=""
        />
      )}

      {/* LP lock is the mechanic behind most memecoin losses and no other source
          in this stack can see it. It earns a line whatever its value. */}
      {risk === undefined ? (
        <div className="text-[11.5px] faint leading-relaxed">— LP lock unknown: nobody graded this mint</div>
      ) : risk.lpLockedPct === undefined ? (
        <div className="text-[11.5px] faint leading-relaxed" title={`${risk.source} did not report a lock figure`}>
          — LP lock not reported by {risk.source}
        </div>
      ) : (
        <LpLockLine lockedPct={risk.lpLockedPct} providers={risk.totalLpProviders} by={risk.source} />
      )}

      {risk?.transferFeePct !== undefined && risk.transferFeePct > 0 && (
        <div className="text-[11.5px] neg leading-relaxed">
          ✕ Transfer fee {(risk.transferFeePct * 100).toFixed(2)}% on every send{" "}
          <span className="faint">({risk.source})</span>
        </div>
      )}

      {risk && (marketLine(risk).length > 0 || risk.insiderNetworks !== undefined) && (
        <div className="text-[10.5px] faint mt-2 num leading-snug">
          {/* Built from parts and joined, rather than concatenated with leading
              separators. The old form printed "22 pools · 0 LP providers ·
              $2.43M across them" — impossible on its face — and, once the
              provider normalised those zeros away, would have printed a
              dangling " · $2.43M across them" with nothing before it. It also
              said "1 pools". */}
          {marketLine(risk).join(" · ")}
          {risk.insiderNetworks !== undefined && (
            <>
              {marketLine(risk).length > 0 ? " · " : ""}
              {/* Scoped explicitly. This line and the Insider Risk factor sat on
                  one screen saying "3 insider networks, 12 wallets" and
                  "insider-linked wallets hold ~0% of supply" — both true of
                  different populations, and read together, nonsense. */}
              <span
                className={risk.insiderNetworks > 0 ? "warn" : ""}
                title="Found by the vendor's graph analysis across the whole holder base. The Insider Risk factor in the audit only sums insider flags among the published top holders, so a network below them scores zero there and still appears here."
              >
                {risk.insiderNetworks} insider network{risk.insiderNetworks === 1 ? "" : "s"}
                {risk.graphInsiders !== undefined ? `, ${risk.graphInsiders} wallets` : ""} chain-wide
              </span>
            </>
          )}
        </div>
      )}

      {risk?.rugged && (
        <div className="text-[11.5px] neg font-semibold mt-2">
          ⚠ {risk.source} has flagged this mint as ALREADY RUGGED.
        </div>
      )}

      {(dangers.length > 0 || warns.length > 0) && (
        <div className="mt-2 border-t border-[var(--border)] pt-2">
          <div className="text-[10px] faint mb-1">
            Named findings from {risk?.source} — their words, their severities, not Nova&rsquo;s score.
          </div>
          {dangers.map((r, i) => (
            <div key={`d${i}`} className="text-[11px] neg leading-snug mb-0.5" title={r.detail}>
              ✕ {r.name}
              {r.value ? ` — ${r.value}` : ""}
            </div>
          ))}
          {warns.map((r, i) => (
            <div key={`w${i}`} className="text-[11px] warn leading-snug mb-0.5" title={r.detail}>
              ⚠ {r.name}
              {r.value ? ` — ${r.value}` : ""}
            </div>
          ))}
        </div>
      )}
      {risk && dangers.length === 0 && warns.length === 0 && (
        <div className="text-[11px] dim mt-2 leading-snug">
          {risk.source} raised no critical or warning findings. That is their checklist coming back
          clean, not a guarantee.
        </div>
      )}
    </div>
  );
}

/**
 * The pools / providers / pooled-liquidity strip, as a list of parts.
 *
 * Every entry is present only when somebody published it, and each one carries
 * its own unit, so an absent field removes a part rather than leaving a
 * dangling separator. Pluralised, because "1 pools" in a panel of exact figures
 * reads as a bug in the panel.
 */
function marketLine(risk: NonNullable<LiveTokenDetail["risk"]>): string[] {
  const parts: string[] = [];
  if (risk.markets !== undefined) parts.push(`${risk.markets} pool${risk.markets === 1 ? "" : "s"}`);
  if (risk.totalLpProviders !== undefined) {
    parts.push(`${risk.totalLpProviders} LP provider${risk.totalLpProviders === 1 ? "" : "s"}`);
  }
  if (risk.totalMarketLiquidityUsd !== undefined) {
    parts.push(`${fmtUsd(risk.totalMarketLiquidityUsd)} across them (${risk.source})`);
  }
  return parts;
}

/**
 * The LP lock line, which has to carry the PROVIDER COUNT or it states a
 * falsehood.
 *
 * "only 0.0% of LP locked — the pool can be withdrawn" was printed for PUMP
 * directly above "435 pools · 43 LP providers". With forty-three independent
 * parties holding the LP, no one of them can withdraw the pool, so that
 * sentence is not true — and it was the largest single penalty on the page.
 * The states below are the genuinely different situations that one sentence
 * was collapsing.
 */
function LpLockLine({
  lockedPct,
  providers,
  by,
}: {
  lockedPct: number;
  providers: number | undefined;
  by: string;
}) {
  const locked = `${(lockedPct * 100).toFixed(1)}% of LP locked or burned`;
  if (lockedPct >= 0.5) {
    return <Attributed ok verified by={by} okText={locked} badText="" unverifiedText="" />;
  }
  if (providers === undefined) {
    return (
      <div className="text-[11.5px] neg leading-relaxed">
        ✕ only {locked} — the rest can be withdrawn, and no source here says by how many separate
        parties it is held <span className="faint">({by})</span>
      </div>
    );
  }
  if (providers <= 1) {
    return (
      <div className="text-[11.5px] neg leading-relaxed">
        ✕ only {locked}, and one provider holds the pool — that party can withdraw it{" "}
        <span className="faint">({by})</span>
      </div>
    );
  }
  return (
    <div
      className="text-[11.5px] warn leading-relaxed"
      title="The LP Lock penalty in the audit is scaled by 1/sqrt(providers): full weight at one provider or an unknown count, and falling from there. The split between them is not published, so the penalty is reduced rather than removed."
    >
      ⚠ only {locked}, but it is spread over {providers} independent providers — no single one of
      them can withdraw the pool, so the penalty is scaled down rather than charged in full{" "}
      <span className="faint">({by})</span>
    </div>
  );
}

function CreatorCard({ detail }: { detail: LiveTokenDetail }) {
  const c = detail.creator;
  const serial = (c.mints ?? 0) >= 10;
  return (
    <div className="panel p-3">
      <div className="panel-title mb-2">Deployer</div>
      {c.address ? (
        <a
          className="num text-[11px] link break-all"
          href={`${EXPLORER}${c.address}`}
          target="_blank"
          rel="noreferrer"
        >
          {c.address} ↗
        </a>
      ) : (
        <div className="text-[11.5px] faint">
          — {detail.source} did not name a deployer. Unknown, not self-deployed.
        </div>
      )}
      {c.vendorAddress && c.vendorAddress !== c.address && (
        <div className="text-[10.5px] warn mt-1 leading-snug">
          A second source names a different deployer — see the disagreement panel.
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2.5 text-[11.5px]">
        <Field label="Tokens minted">
          {c.mints === undefined ? (
            <Dash why="the source published no creator history" />
          ) : (
            <span className={serial ? "warn" : "dim"}>{c.mints.toLocaleString()}</span>
          )}
        </Field>
        <Field label="Reached a pool">
          {c.migrations === undefined ? (
            <Dash why="the source published no migration count" />
          ) : (
            <span className="dim">{c.migrations.toLocaleString()}</span>
          )}
        </Field>
        {/* ONE answer, from `holdsShown`, which resolves the two sources in a
            stated order. This cell used to read the token provider's figure
            alone and print a dash saying "no source published the deployer's
            balance — this is not zero" one line above a footnote reading
            "rugcheck independently puts the deployer balance at 0.000%". Both
            sentences were on screen for PUMP, SKHY, TRX and CATE, and one of
            them had to be wrong. */}
        <Field label="Dev still holds">
          {c.holdsShown === undefined ? (
            <Dash why="no source published the deployer's balance — this is not zero" />
          ) : (
            <span
              className={c.holdsShown.pct > 0.05 ? "warn" : "dim"}
              title={`per ${c.holdsShown.source}`}
            >
              {(c.holdsShown.pct * 100).toFixed(3)}%
            </span>
          )}
        </Field>
        <Field label="Graduated">
          {c.graduatedAt === undefined ? (
            <Dash why="never graduated a bonding curve, or the source did not say" />
          ) : (
            <span className="dim" title={new Date(c.graduatedAt).toISOString()}>
              {fmtAge(detail.asOf - c.graduatedAt)} ago
            </span>
          )}
        </Field>
      </div>
      {/* The second opinion, shown ONLY when it is genuinely a second one. If
          the vendor is the source of the figure above, repeating it here as
          "independently puts" would manufacture corroboration out of one
          reading. */}
      {c.vendorHoldsPct !== undefined &&
        detail.risk &&
        c.holdsShown !== undefined &&
        c.holdsShown.source !== detail.risk.source && (
          <div className="text-[10.5px] faint mt-1.5 num">
            {detail.risk.source} independently puts the deployer balance at{" "}
            {(c.vendorHoldsPct * 100).toFixed(3)}%
            {Math.abs(c.vendorHoldsPct - c.holdsShown.pct) > 0.005
              ? " — the two sources disagree; both are shown rather than averaged."
              : "."}
          </div>
        )}
      <div className="text-[10.5px] faint mt-2 leading-snug">
        {c.mints === undefined
          ? "Nothing here says how many tokens this wallet has launched, which is the single most useful fact about a memecoin deployer."
          : c.mints === 1
            ? "First mint by this wallet. That is not a guarantee of anything — it is simply the absence of a track record."
            : `This wallet has issued ${c.mints.toLocaleString()} mints${c.migrations !== undefined ? `, ${c.migrations.toLocaleString()} of which reached a real pool — ${((c.migrations / c.mints) * 100).toFixed(1)}%` : ""}. A serial deployer is a warning; the ratio is the interesting part.`}
      </div>
    </div>
  );
}

function Disagreements({ items }: { items: LiveTokenDetail["disagreements"] }) {
  return (
    <div className="panel p-3 border-l-2" style={{ borderLeftColor: "var(--warn)" }}>
      <div className="panel-title mb-1.5 warn">
        {items.length} question{items.length === 1 ? "" : "s"} the sources answer differently
      </div>
      <div className="text-[10.5px] faint mb-2 leading-snug">
        Not reconciled. Averaging two irreconcilable counts would manufacture a third number nobody
        measured, so both claims are shown with the source attached.
      </div>
      <div className="flex flex-col gap-2">
        {items.map((d, i) => (
          <div key={i} className="text-[11.5px] leading-snug">
            <div className="dim">{d.question}?</div>
            <div className="flex gap-4 flex-wrap mt-0.5">
              {d.claims.map((c, j) => (
                <span key={j} className="num">
                  <span className="faint text-[10px]">{c.source}</span>{" "}
                  <span className="warn break-all">{c.value}</span>
                </span>
              ))}
            </div>
            <div className="faint text-[10.5px] mt-0.5">{d.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProvenancePanel({ lines, asOf }: { lines: string[]; asOf: number }) {
  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between">
        <span className="panel-title">Where every number came from</span>
        <Freshness ts={asOf} />
      </div>
      <div className="mt-1.5">
        {lines.map((l, i) => (
          <div
            key={i}
            className={`text-[10.5px] leading-snug mb-0.5 ${l.startsWith("WARNING") ? "warn" : "faint"}`}
          >
            · {l}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- shared bits

/** Which social links to surface, and in what order. */
const LINK_KINDS: readonly [keyof NonNullable<TokenInfo["links"]>, string][] = [
  ["website", "site"],
  ["twitter", "X"],
  ["telegram", "TG"],
];

/**
 * 5m / 1h / 6h / 24h price change.
 *
 * Every window that was not published renders a dash rather than +0.0%, which
 * on a price-change strip is the most misleading zero on the page: a flat tape
 * and an unfetched one look identical, and this is the number a reader glances
 * at before anything else.
 */
function ChangeStrip({ snap, source }: { snap: TokenSnapshot; source: string }) {
  const why = `${source} published no price change for this window`;
  const windows: [string, number | undefined][] = [
    ["5m", snap.momentum5m],
    ["1h", snap.momentum1h],
    ["6h", snap.momentum6h],
    ["24h", snap.momentum24h],
  ];
  return (
    <div className="text-right">
      <div className="panel-title">Change</div>
      <div className="mt-0.5 flex items-center gap-2.5">
        {windows.map(([label, value]) => (
          <span key={label} className="flex items-baseline gap-1">
            <span className="faint text-[9.5px]">{label}</span>
            {value === undefined ? (
              <Dash why={why} />
            ) : (
              <span className={value >= 0 ? "pos" : "neg"}>{fmtPct(value)}</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function HeaderStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-right">
      <div className="panel-title">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="faint text-[10.5px]">{label}</span>
      <span className="num">{children}</span>
    </div>
  );
}

/**
 * An on-chain address, linked to BOTH places a reader might want it.
 *
 * Every address in the holder table and the flow table pointed at solscan and
 * nowhere else — so the most natural click in the product, from a wallet that
 * just moved size to that wallet's profile, left the product entirely. The
 * scanner made the opposite choice for its own mover list, and these two tables
 * were the ones that did not.
 *
 * Nova's own page leads, because that is the one this app can say something
 * about; the explorer keeps its arrow and its new tab.
 */
function AddressLinks({ owner, account }: { owner: string; account?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Link
        className="hover:text-[var(--accent)]"
        href={`/whale?a=${owner}`}
        title={account ? `owner ${owner}\ntoken account ${account}\n\nOpen this wallet in Nova` : `${owner}\n\nOpen this wallet in Nova`}
      >
        {shortAddr(owner)}
      </Link>
      <a
        className="faint hover:text-[var(--accent)] text-[10px]"
        href={`${EXPLORER}${owner}`}
        target="_blank"
        rel="noreferrer"
        title="open on solscan"
      >
        ↗
      </a>
    </span>
  );
}

/**
 * A number nobody measured, rendered as a dash that explains itself.
 *
 * The rule this whole codebase is built around: a zero in a holder or dev
 * column reads as a perfectly distributed token with an honest deployer, and
 * the truth is almost always that nobody looked.
 */
function Dash({ why }: { why: string }) {
  return (
    <span className="faint" title={why}>
      —
    </span>
  );
}

/**
 * A factor's contribution, signed only where a sign means something.
 *
 * A risk row's points can never be positive, so a leading "+" on its zero reads
 * as a bonus. And a penalty that rounds to nothing prints "-0.0" without the
 * rescale below, which looks like a bug in a column of exact figures.
 */
function points(value: number, isRisk: boolean): string {
  const v = Math.abs(value) < 0.05 ? 0 : value;
  if (isRisk) return v.toFixed(1);
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
}

function Bar({ value, bad = false }: { value: number; bad?: boolean }) {
  const fraction = Math.max(0, Math.min(1, value));
  return (
    <span className="scorebar" style={{ width: 110, display: "inline-block" }}>
      <div style={{ transform: `scaleX(${fraction})`, background: bad ? "var(--neg)" : "var(--accent)" }} />
    </span>
  );
}

/**
 * A security line that names its source, and distinguishes "checked and clean"
 * from "nobody checked".
 *
 * The keyless providers report both authorities as not-revoked whether they
 * read the mint account or not. Grading that as unsafe is right; printing it as
 * "mint authority is LIVE" states a fact nobody established.
 */
function Attributed({
  ok,
  verified,
  by,
  okText,
  badText,
  unverifiedText,
}: {
  ok: boolean;
  verified: boolean;
  by: string;
  okText: string;
  badText: string;
  unverifiedText: string;
}) {
  if (!verified && unverifiedText) {
    return (
      <div className="text-[11.5px] warn leading-relaxed" title={`no source in this stack read the mint account`}>
        ? {unverifiedText}
      </div>
    );
  }
  return (
    <div className={`text-[11.5px] leading-relaxed ${ok ? "dim" : "neg"}`}>
      {ok ? "✓" : "✕"} {ok ? okText : badText} <span className="faint">({by})</span>
    </div>
  );
}

// ---------------------------------------------------------------- demo token

function DemoToken({ detail, mint, candles }: { detail: DemoTokenDetail; mint: string; candles: CandleHook }) {
  const data = detail;
  const { info, snapshot: snap, signal, risk } = data;
  // Owned by TokenInner now, like the live half — one subscription, started in
  // parallel with the detail fetch.
  const candleData = candles.data;
  const { data: paper } = useApi<{ portfolios: { id: string; name: string; cashUsd: number }[] }>("/api/paper");
  const [tradeMsg, setTradeMsg] = useState<string | null>(null);
  const [tradeUsd, setTradeUsd] = useState("250");
  const [asking, setAsking] = useState<ResearchAnswer | null>(null);
  // Kept so a rewording gets the question as context, not just the answer.
  const [askedQ, setAskedQ] = useState("");
  const ai = useSyncExternalStore(subscribeAi, getAiSnapshot, getAiServerSnapshot);

  const markers = useMemo<ChartMarker[]>(
    () =>
      data.trades
        // A marker named whale_buy must use the whale threshold. This filtered
        // at $8,000 and painted the result as a whale — a fourth definition of
        // the word, on the one chart where the markers are labelled with it.
        .filter((t) => t.amountUsd >= WHALE_USD)
        .slice(0, 40)
        .map((t) => ({
          ts: t.ts,
          kind: t.side === "buy" ? ("whale_buy" as const) : ("whale_sell" as const),
          text: `${t.side === "buy" ? "▲" : "▼"} ${fmtUsd(t.amountUsd)}`,
        })),
    [data.trades],
  );

  const doPaperTrade = async (side: "buy" | "sell") => {
    const pf = paper?.portfolios[0];
    if (!pf) return setTradeMsg("no paper portfolio");
    setTradeMsg("…");
    const res = await apiPost<{ error?: string; fill?: { priceUsd: number; slippagePct: number } }>("/api/paper/orders", {
      portfolioId: pf.id,
      mint,
      side,
      usd: Number(tradeUsd) || 0,
    });
    setTradeMsg(
      res.body.error
        ? `rejected: ${res.body.error}`
        : `${side} filled @ ${fmtUsd(res.body.fill?.priceUsd)} (slippage ${res.body.fill?.slippagePct.toFixed(2)}%)`,
    );
  };

  const ask = async (q: string) => {
    setAskedQ(q);
    setAsking({ answer: "…", evidence: [] });
    const res = await apiPost<ResearchAnswer>("/api/research/ask", { question: q });
    setAsking(res.body);
  };

  return (
    <div className="p-3 flex flex-col gap-3">
      {/* header */}
      <div className="panel px-4 py-3 flex items-center gap-4 flex-wrap">
        <TokenMark hue={info.hue} symbol={info.symbol} size={38} />
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[17px] font-semibold">{info.symbol}</span>
            <span className="dim text-[13px]">{info.name}</span>
            {info.verified && <span className="chip chip-accent">verified</span>}
            <span className="chip">{info.narrative}</span>
            <span className="chip">{fmtAge(data.asOf - info.createdAt)} old</span>
            <span className="chip chip-warn" title="this mint exists only in the deterministic demo universe">
              SIMULATED
            </span>
          </div>
          <button
            className="num text-[10.5px] faint hover:text-[var(--accent)]"
            onClick={() => navigator.clipboard?.writeText(info.mint)}
            title="copy mint"
          >
            {info.mint} ⧉
          </button>
        </div>
        <div className="flex items-center gap-5 ml-auto num text-[13px]">
          <HeaderStat label="Price">{fmtUsd(snap.priceUsd)}</HeaderStat>
          <HeaderStat label="Mcap">{fmtUsd(snap.marketCapUsd)}</HeaderStat>
          <HeaderStat label="Liquidity">{fmtUsd(snap.liquidityUsd)}</HeaderStat>
          <HeaderStat label="Holders">{fmtNum(snap.holders)}</HeaderStat>
          {signal && (
            <HeaderStat label="Signal">
              <span className="flex items-center gap-2">
                <Score value={signal.score} width={50} />
                <span className={`chip ${labelClass(signal.label)}`}>{signal.label}</span>
              </span>
            </HeaderStat>
          )}
          {risk && (
            <HeaderStat label="Risk">
              <RiskBadge level={risk.overall} />
            </HeaderStat>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-3">
        {/* left column */}
        <div className="flex flex-col gap-3 min-w-0">
          <div className="panel">
            <div className="flex items-center justify-between px-3 pt-2.5">
              {/* The measured label, not an assumed "hourly" — the simulator
                  does plot hourly bars, and this is how the caption knows. */}
              <span className="panel-title">
                Price{candleData?.interval ? ` · ${candleData.interval}` : ""} · whale markers ≥ $8K
              </span>
              <span className="flex items-center gap-2">
                {/* Per-panel provenance. The global SIMULATED DATA chip in the
                    nav describes the app; this describes THIS chart, which is
                    the only honest way to run one real panel beside synthetic
                    ones. A fallback says so in its own title text rather than
                    quietly wearing a live badge. */}
                {candleData?.provenance && (
                  <span
                    className={`chip ${candleData.provenance.real ? "chip-accent" : "chip-warn"}`}
                    title={candleData.provenance.note ?? "real market data"}
                  >
                    {candleData.provenance.real ? candleData.provenance.source.toUpperCase() : "SIMULATED"}
                  </span>
                )}
                <Freshness ts={snap.ts} />
              </span>
            </div>
            <div className="px-2 pb-2">
              {candleData ? (
                <PriceChart candles={candleData.candles} markers={markers} livePrice={candleData.live} height={330} />
              ) : (
                <div className="h-[330px] flex items-center justify-center faint text-[11px]">LOADING CHART…</div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="panel">
              <div className="panel-title px-3 pt-2.5">Whale flow · 72h · smart-money line</div>
              <div className="px-2 pb-2"><FlowChart flow={data.flow} height={190} /></div>
            </div>
            <div className="panel">
              <div className="panel-title px-3 pt-2.5">Holders</div>
              <div className="px-2 pb-2">
                <LineChart points={data.holdersSeries.map((p) => ({ ts: p.ts, value: p.holders }))} height={190} color="#8b7cff" />
              </div>
            </div>
          </div>

          {/* top traders */}
          <div className="panel">
            <div className="panel-title px-3 pt-2.5 pb-1">Top tracked traders on this token</div>
            <table className="w-full text-[12px]">
              <thead className="thead">
                <tr>
                  <th className="text-left px-3 py-1.5 font-medium">Wallet</th>
                  <th className="text-right px-2 font-medium">SM score</th>
                  <th className="text-right px-2 font-medium">Buys/Sells</th>
                  <th className="text-right px-2 font-medium">Net realized</th>
                  <th className="text-right px-2 font-medium">Unrealized</th>
                  <th className="text-right px-3 font-medium">Holding</th>
                </tr>
              </thead>
              <tbody className="num">
                {data.topTraders.map((t) => (
                  <tr key={t.address} className="trow">
                    <td className="px-3 py-1.5">
                      <Link href={`/whale?a=${t.address}`} className="hover:text-[var(--accent)]">
                        {t.entity ?? shortAddr(t.address)}
                        <span className="faint text-[10px] ml-2">{t.labels.slice(0, 2).join(", ")}</span>
                      </Link>
                    </td>
                    <td className="text-right px-2">{t.smartMoneyScore}</td>
                    <td className="text-right px-2 dim">{t.buys}/{t.sells}</td>
                    <td className={`text-right px-2 ${t.netUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(t.netUsd)}</td>
                    <td className={`text-right px-2 ${t.unrealizedUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(t.unrealizedUsd)}</td>
                    <td className="text-right px-3">{t.holding ? <span className="pos">yes</span> : <span className="faint">no</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* transactions */}
          <div className="panel">
            <div className="panel-title px-3 pt-2.5 pb-1">Tracked transactions · 72h</div>
            <div className="max-h-[280px] overflow-y-auto">
              <table className="w-full text-[11.5px]">
                <tbody className="num">
                  {data.trades.map((t) => (
                    <tr key={t.id} className="trow">
                      <td className="px-3 py-1 faint">{new Date(t.ts).toLocaleTimeString()}</td>
                      <td className={`px-2 ${t.side === "buy" ? "pos" : "neg"}`}>{t.side.toUpperCase()}</td>
                      <td className="px-2">{fmtUsd(t.amountUsd)}</td>
                      <td className="px-2 dim">
                        <Link href={`/whale?a=${t.wallet}`} className="hover:text-[var(--accent)]">{shortAddr(t.wallet)}</Link>
                      </td>
                      <td className="px-2 faint">{t.dex}</td>
                      <td className="px-2 faint">{t.classification}</td>
                      <td className="px-2 faint text-right" title={t.signature}>conf {(t.confidence * 100).toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.trades.length === 0 && <Empty>No tracked-wallet transactions in the window.</Empty>}
            </div>
          </div>
        </div>

        {/* right column */}
        <div className="flex flex-col gap-3">
          {/* actions */}
          <div className="panel p-3 flex flex-col gap-2">
            <div className="panel-title">Desk actions · paper only</div>
            <div className="flex gap-2">
              <input value={tradeUsd} onChange={(e) => setTradeUsd(e.target.value)} className="input w-[90px]" />
              <button className="btn btn-primary flex-1 justify-center" onClick={() => doPaperTrade("buy")}>Paper buy</button>
              <button className="btn btn-danger flex-1 justify-center" onClick={() => doPaperTrade("sell")}>Paper sell</button>
            </div>
            {tradeMsg && <div className="text-[11px] dim num">{tradeMsg}</div>}
            <div className="flex gap-2 flex-wrap">
              <button className="btn text-[11px]" onClick={() => ask(`why is ${info.symbol} moving`)}>WHY IS THIS MOVING?</button>
              <button className="btn text-[11px]" onClick={() => ask(`what did whales do on ${info.symbol}`)}>WHAT DID WHALES DO?</button>
            </div>
            {asking && (
              <div className="border-t border-[var(--border)] pt-2">
                <NarratedAnswer
                  answer={{
                    question: askedQ || `about ${info.symbol}`,
                    answer: asking.answer,
                    evidence: asking.evidence ?? [],
                  }}
                  ai={ai}
                  compact
                />
              </div>
            )}
          </div>

          {/* signal breakdown */}
          {signal && (
            <div className="panel p-3">
              <div className="flex items-center justify-between">
                <span className="panel-title">Signal · {signal.kind.replace(/_/g, " ")}</span>
                <Link href={`/signal?id=${signal.id}`} className="link text-[10.5px]">investigate →</Link>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <Score value={signal.score} width={100} />
                <span className="num text-[11px] faint">confidence {(signal.confidence * 100).toFixed(0)}%</span>
              </div>
              <div className="mt-2.5">
                <div className="text-[10.5px] pos font-semibold tracking-wide mb-1">WHY</div>
                {signal.why.map((w, i) => (
                  <div key={i} className="text-[11.5px] dim leading-snug mb-0.5">· {w}</div>
                ))}
                <div className="text-[10.5px] neg font-semibold tracking-wide mt-2 mb-1">WHAT COULD MAKE THIS FAIL</div>
                {signal.bearCase.slice(0, 4).map((w, i) => (
                  <div key={i} className="text-[11.5px] dim leading-snug mb-0.5">· {w}</div>
                ))}
                <div className="text-[10.5px] warn font-semibold tracking-wide mt-2 mb-1">INVALIDATION</div>
                {signal.invalidation.slice(0, 3).map((w, i) => (
                  <div key={i} className="text-[11.5px] dim leading-snug mb-0.5">· {w}</div>
                ))}
              </div>
            </div>
          )}

          {/* risk radar */}
          {risk && (
            <div className="panel p-3">
              <div className="panel-title mb-2">Risk radar</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11.5px]">
                {(
                  [
                    ["Security", risk.security],
                    ["Liquidity", risk.liquidity],
                    ["Concentration", risk.concentration],
                    ["Dev", risk.dev],
                    ["Bundler", risk.bundler],
                    ["Organic", risk.organic],
                    ["Structure", risk.structure],
                    ["OVERALL", risk.overall],
                  ] as const
                ).map(([label, level]) => (
                  <div key={label} className="flex items-center justify-between">
                    <span className={label === "OVERALL" ? "font-semibold" : "dim"}>{label}</span>
                    <RiskBadge level={level} />
                  </div>
                ))}
              </div>
              {risk.notes.length > 0 && (
                <div className="mt-2 border-t border-[var(--border)] pt-2">
                  {risk.notes.map((n, i) => (
                    <div key={i} className="text-[11px] warn leading-snug mb-0.5">⚠ {n}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* security */}
          <div className="panel p-3">
            <div className="panel-title mb-2">Token security</div>
            <SecRow ok={info.mintAuthorityRevoked} okText="Mint authority revoked" badText="Mint authority ACTIVE — supply can inflate" />
            <SecRow ok={info.freezeAuthorityRevoked} okText="Freeze authority revoked" badText="Freeze authority ACTIVE — transfers can freeze" />
            <SecRow ok={!info.permanentDelegate} okText="No permanent delegate" badText="Permanent delegate SET" />
            <SecRow ok={snap.top10Pct < 0.3} okText={`Top 10 hold ${(snap.top10Pct * 100).toFixed(0)}%`} badText={`Top 10 hold ${(snap.top10Pct * 100).toFixed(0)}% of supply`} />
            <SecRow ok={snap.devHoldsPct < 0.06} okText={`Dev holds ${(snap.devHoldsPct * 100).toFixed(1)}%`} badText={`Dev holds ${(snap.devHoldsPct * 100).toFixed(1)}%`} />
            <div className="text-[10.5px] faint mt-2 num">
              bundlers {(snap.bundlerPct * 100).toFixed(1)}% · snipers {(snap.sniperPct * 100).toFixed(1)}% · insiders {(snap.insiderPct * 100).toFixed(1)}%
            </div>
          </div>

          {/* similar setups */}
          {data.similar && data.similar.samples >= 5 && (
            <div className="panel p-3">
              <div className="panel-title mb-1.5">Similar historical setups</div>
              <div className="text-[11.5px] dim leading-relaxed">
                Across <span className="num">{data.similar.samples}</span> similar moments, median 24h outcome{" "}
                <span className={`num ${data.similar.median24h >= 0 ? "pos" : "neg"}`}>{fmtPct(data.similar.median24h)}</span>, range{" "}
                <span className="num neg">{fmtPct(data.similar.p10_24h)}</span> to{" "}
                <span className="num pos">{fmtPct(data.similar.p90_24h)}</span> (p10–p90). Distribution, not destiny.
              </div>
              <div className="mt-2 space-y-1">
                {data.similar.matches.slice(0, 5).map((m, i) => (
                  <div key={i} className="flex justify-between text-[11px] num">
                    <Link href={`/token?m=${m.mint}`} className="dim hover:text-[var(--accent)]">{m.symbol}</Link>
                    <span className={m.outcome24hPct >= 0 ? "pos" : "neg"}>{fmtPct(m.outcome24hPct)} 24h</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SecRow({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <div className={`text-[11.5px] leading-relaxed ${ok ? "dim" : "neg"}`}>
      {ok ? "✓" : "✕"} {ok ? okText : badText}
    </div>
  );
}
