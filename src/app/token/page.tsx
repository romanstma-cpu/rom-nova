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

import { Suspense, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useApi, apiPost, fmtUsd, fmtPct, fmtNum, fmtAge, shortAddr, labelClass } from "@/lib/client";
import { Score, RiskBadge, TokenMark, Freshness, Empty } from "@/components/ui/bits";
import { PriceChart, type ChartMarker } from "@/components/charts/PriceChart";
import { FlowChart } from "@/components/charts/FlowChart";
import { LineChart } from "@/components/charts/LineChart";
import type { Candle, RiskRadar, Signal, TokenInfo, TokenSnapshot, UnmeasuredField, WalletTrade } from "@/lib/types";
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

function TokenInner() {
  const mint = useSearchParams().get("m") ?? "";
  // Thirty seconds, not fifteen. A live assembly reaches five providers and
  // pulls a risk report measured up to 1.1MB; `liveTokenDetail` caches for
  // twenty, so a faster poll would re-render the same payload and a slower one
  // would show a stale price.
  const { data, error, loading } = useApi<TokenDetail>(mint ? `/api/tokens/${mint}` : null, 30_000);

  if (!mint || error) {
    return (
      <Empty>
        {error ? `Could not load this token: ${error}. ` : "Token not found. "}
        <Link className="link" href="/scanner">
          Back to the scanner.
        </Link>
      </Empty>
    );
  }
  if (!data) return <Empty>{loading ? "ANALYZING TOKEN…" : "NO DATA"}</Empty>;
  // Branching at a component boundary rather than inside one: the two halves
  // need different hooks, and hooks cannot be called conditionally.
  return data.mode === "live" ? <LiveToken detail={data} /> : <DemoToken detail={data} mint={mint} />;
}

// ---------------------------------------------------------------- live token

function LiveToken({ detail }: { detail: LiveTokenDetail }) {
  const d = detail;
  const { info, snapshot: snap, signal, risk } = d;
  // The error matters as much as the data. A mint with no pool on the history
  // source used to leave this panel on "LOADING CHART…" indefinitely, which is
  // the chart-shaped version of rendering an unmeasured field as a zero: an
  // absence wearing the appearance of something still on its way.
  const { data: candleData, error: candleError } = useApi<CandlePayload>(
    `/api/tokens/${info.mint}/candles`,
    60_000,
  );
  const [logScale, setLogScale] = useState(false);
  const [bars, setBars] = useState<24 | 168 | 720 | 0>(0);
  const [copied, setCopied] = useState(false);

  const shown = useMemo(() => {
    const all = candleData?.candles ?? [];
    return bars === 0 ? all : all.slice(-bars);
  }, [candleData, bars]);

  // The wallets that actually moved size, on the chart. Only the ones inside the
  // bars being shown — a marker at a timestamp off the left edge is invisible
  // and counts as a promise the chart did not keep.
  const markers = useMemo<ChartMarker[]>(() => {
    const movers = d.flow?.movers ?? [];
    if (!movers.length || shown.length === 0) return [];
    const at = shown[shown.length - 1].t;
    return movers
      .filter((m) => Math.abs(m.usd) >= 5_000)
      .slice(0, 12)
      .map((m) => ({
        ts: at,
        kind: m.usd >= 0 ? ("whale_buy" as const) : ("whale_sell" as const),
        text: `${m.usd >= 0 ? "▲" : "▼"} ${fmtUsd(Math.abs(m.usd))}`,
      }));
  }, [d.flow, shown]);

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
          <div className="flex items-center gap-2 mt-0.5">
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
          </div>
        </div>
        <div className="flex items-center gap-5 ml-auto num text-[13px] flex-wrap">
          <HeaderStat label="Price">{fmtUsd(snap.priceUsd)}</HeaderStat>
          <HeaderStat label="Mcap">{fmtUsd(snap.marketCapUsd)}</HeaderStat>
          <HeaderStat label="Liquidity">{fmtUsd(snap.liquidityUsd)}</HeaderStat>
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

      {d.disagreements.length > 0 && <Disagreements items={d.disagreements} />}

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-3">
        <div className="flex flex-col gap-3 min-w-0">
          {/* chart */}
          <div className="panel">
            <div className="flex items-center justify-between px-3 pt-2.5 gap-2 flex-wrap">
              <span className="panel-title">Price · hourly bars</span>
              <span className="flex items-center gap-2">
                {([
                  [24, "24h"],
                  [168, "7d"],
                  [720, "30d"],
                  [0, "all"],
                ] as const).map(([n, label]) => (
                  <button
                    key={label}
                    className={`btn text-[10px] px-1.5 py-0.5 ${bars === n ? "btn-primary" : ""}`}
                    onClick={() => setBars(n)}
                  >
                    {label}
                  </button>
                ))}
                <button
                  className={`btn text-[10px] px-1.5 py-0.5 ${logScale ? "btn-primary" : ""}`}
                  onClick={() => setLogScale((x) => !x)}
                  title="logarithmic price axis"
                >
                  log
                </button>
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
              {candleError ? (
                <div className="h-[340px] flex items-center justify-center faint text-[11px] px-8 text-center leading-relaxed">
                  No price history for this mint — {candleError}. The rest of this page does not
                  depend on it: the score never read these bars.
                </div>
              ) : candleData ? (
                shown.length > 0 ? (
                  <PriceChart candles={shown} markers={markers} height={340} logScale={logScale} />
                ) : (
                  <div className="h-[340px] flex items-center justify-center faint text-[11px] px-8 text-center">
                    No hourly bars in this range.{" "}
                    {candleData.provenance?.note ?? "The history source returned nothing."}
                  </div>
                )
              ) : (
                <div className="h-[340px] flex items-center justify-center faint text-[11px]">LOADING CHART…</div>
              )}
            </div>
            <div className="px-3 pb-2 text-[10px] faint leading-snug">
              Markers are the wallets in the flow panel below, placed on the newest bar — the flow
              window is ten minutes, not the life of the chart, so they say <b>who moved recently</b>,
              not when. The score above does not read these bars: with no candles in its vector it
              takes momentum from {d.source}&rsquo;s published 1h and 24h change, which the audit
              names.
            </div>
          </div>

          <ScoreAuditPanel detail={d} />
          <HolderPanel detail={d} />
          <FlowPanelView detail={d} />
        </div>

        <div className="flex flex-col gap-3">
          <SecurityPanel detail={d} />
          <CreatorCard detail={d} />

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

function ScoreAuditPanel({ detail }: { detail: LiveTokenDetail }) {
  const { signal, audit } = detail;
  const stood = audit.rows.filter((r) => !r.measured);
  return (
    <div className="panel">
      <div className="flex items-center justify-between px-3 pt-2.5 gap-2 flex-wrap">
        <span className="panel-title">The score, every factor</span>
        <span className="num text-[10.5px] faint">
          {(audit.coverage * 100).toFixed(0)}% of the model&rsquo;s weight available · confidence{" "}
          {(signal.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <div className="px-3 pt-1 pb-1.5 text-[10.5px] faint leading-snug">
        Contribution is signed points on the 0-100 scale. A factor that <b>stood down</b> left the
        weighted mean entirely rather than scoring its missing input as a zero, and the confidence
        above fell by its weight — {audit.missingWeight.toFixed(1)} of weight went unused and{" "}
        {audit.unmeasuredRisks} risk factor{audit.unmeasuredRisks === 1 ? "" : "s"} could not be
        assessed at all.
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
      {signal.noTradeReason && (
        <div className="px-3 py-2 border-t border-[var(--border)] text-[11.5px] warn leading-snug">
          <b>NO TRADE</b> — {signal.noTradeReason}. The engine is allowed to abstain, and{" "}
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
                    <a
                      className="hover:text-[var(--accent)]"
                      href={`${EXPLORER}${r.owner}`}
                      target="_blank"
                      rel="noreferrer"
                      title={r.account ? `owner ${r.owner}\ntoken account ${r.account}` : r.owner}
                    >
                      {shortAddr(r.owner)} ↗
                    </a>
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
        distributing) · <span className="num">{f.touchedNotMoved}</span> rows were accounts merely
        touched by a transaction and discarded. Every address below is real and checkable.
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
                  <a
                    className="hover:text-[var(--accent)]"
                    href={`${EXPLORER}${m.owner}`}
                    target="_blank"
                    rel="noreferrer"
                    title={m.owner}
                  >
                    {shortAddr(m.owner)} ↗
                  </a>
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

      <Attributed
        ok={info.mintAuthorityRevoked}
        verified={authorityChecked}
        by={authorityChecked ? (authoritySource ?? "chain") : source}
        okText="Mint authority revoked — supply is fixed"
        badText="Mint authority LIVE — supply can be inflated"
        unverifiedText="Mint authority UNVERIFIED — graded as live so an unexamined token is never treated as safe"
      />
      <Attributed
        ok={info.freezeAuthorityRevoked}
        verified={authorityChecked}
        by={authorityChecked ? (authoritySource ?? "chain") : source}
        okText="Freeze authority revoked"
        badText="Freeze authority LIVE — balances can be frozen"
        unverifiedText="Freeze authority UNVERIFIED — graded as live for the same reason"
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
        <Attributed
          ok={risk.lpLockedPct >= 0.5}
          verified
          by={risk.source}
          okText={`${(risk.lpLockedPct * 100).toFixed(1)}% of LP locked or burned`}
          badText={`only ${(risk.lpLockedPct * 100).toFixed(1)}% of LP locked — the pool can be withdrawn`}
          unverifiedText=""
        />
      )}

      {risk?.transferFeePct !== undefined && risk.transferFeePct > 0 && (
        <div className="text-[11.5px] neg leading-relaxed">
          ✕ Transfer fee {(risk.transferFeePct * 100).toFixed(2)}% on every send{" "}
          <span className="faint">({risk.source})</span>
        </div>
      )}

      {risk && (
        <div className="text-[10.5px] faint mt-2 num leading-snug">
          {risk.markets !== undefined && `${risk.markets} pools`}
          {risk.totalLpProviders !== undefined && ` · ${risk.totalLpProviders} LP providers`}
          {risk.totalMarketLiquidityUsd !== undefined &&
            ` · ${fmtUsd(risk.totalMarketLiquidityUsd)} across them (${risk.source})`}
          {risk.insiderNetworks !== undefined && (
            <>
              {" · "}
              <span className={risk.insiderNetworks > 0 ? "warn" : ""}>
                {risk.insiderNetworks} insider network{risk.insiderNetworks === 1 ? "" : "s"}
                {risk.graphInsiders !== undefined ? `, ${risk.graphInsiders} wallets` : ""}
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
            <span className={serial ? "warn" : "dim"}>{c.mints}</span>
          )}
        </Field>
        <Field label="Reached a pool">
          {c.migrations === undefined ? (
            <Dash why="the source published no migration count" />
          ) : (
            <span className="dim">{c.migrations}</span>
          )}
        </Field>
        <Field label="Dev still holds">
          {c.holdsPct === undefined ? (
            <Dash why="no source published the deployer's balance — this is not zero" />
          ) : (
            <span className={c.holdsPct > 0.05 ? "warn" : "dim"}>{(c.holdsPct * 100).toFixed(3)}%</span>
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
      {c.vendorHoldsPct !== undefined && (
        <div className="text-[10.5px] faint mt-1.5 num">
          {detail.risk?.source} independently puts the deployer balance at{" "}
          {(c.vendorHoldsPct * 100).toFixed(3)}%.
        </div>
      )}
      <div className="text-[10.5px] faint mt-2 leading-snug">
        {c.mints === undefined
          ? "Nothing here says how many tokens this wallet has launched, which is the single most useful fact about a memecoin deployer."
          : c.mints === 1
            ? "First mint by this wallet. That is not a guarantee of anything — it is simply the absence of a track record."
            : `This wallet has issued ${c.mints} mints${c.migrations !== undefined ? `, ${c.migrations} of which reached a real pool` : ""}. A serial deployer is a warning; the ratio is the interesting part.`}
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
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span className="scorebar" style={{ width: 110, display: "inline-block" }}>
      <div style={{ width: `${pct}%`, background: bad ? "var(--neg)" : "var(--accent)" }} />
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

function DemoToken({ detail, mint }: { detail: DemoTokenDetail; mint: string }) {
  const data = detail;
  const { info, snapshot: snap, signal, risk } = data;
  const { data: candleData } = useApi<CandlePayload>(`/api/tokens/${mint}/candles`, 10_000);
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
        .filter((t) => t.amountUsd >= 8000)
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
              <span className="panel-title">Price · hourly · whale markers ≥ $8K</span>
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
