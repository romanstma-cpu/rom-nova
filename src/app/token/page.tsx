"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useApi, apiPost, fmtUsd, fmtPct, fmtNum, fmtAge, shortAddr, labelClass } from "@/lib/client";
import { Score, RiskBadge, TokenMark, Freshness, Empty } from "@/components/ui/bits";
import { PriceChart, type ChartMarker } from "@/components/charts/PriceChart";
import { FlowChart } from "@/components/charts/FlowChart";
import { LineChart } from "@/components/charts/LineChart";
import type { Candle, RiskRadar, Signal, TokenInfo, TokenSnapshot, WalletTrade } from "@/lib/types";
import type { FlowPoint } from "@/lib/api/rows";
import type { SimilarityReport } from "@/lib/engine/similarity";

interface TokenDetail {
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

interface ResearchAnswer {
  answer: string;
  evidence: { label: string; value: string }[];
}

export default function TokenPage() {
  return (
    <Suspense fallback={<Empty>ANALYZING TOKEN…</Empty>}>
      <TokenInner />
    </Suspense>
  );
}

function TokenInner() {
  const mint = useSearchParams().get("m") ?? "";
  const { data, error } = useApi<TokenDetail>(mint ? `/api/tokens/${mint}` : null, 15_000);
  const { data: candleData } = useApi<{ candles: Candle[]; live: { ts: number; price: number } | null }>(
    mint ? `/api/tokens/${mint}/candles` : null,
    10_000,
  );
  const { data: paper } = useApi<{ portfolios: { id: string; name: string; cashUsd: number }[] }>("/api/paper");
  const [tradeMsg, setTradeMsg] = useState<string | null>(null);
  const [tradeUsd, setTradeUsd] = useState("250");
  const [asking, setAsking] = useState<ResearchAnswer | null>(null);

  const markers = useMemo<ChartMarker[]>(() => {
    if (!data) return [];
    const ms: ChartMarker[] = data.trades
      .filter((t) => t.amountUsd >= 8000)
      .slice(0, 40)
      .map((t) => ({
        ts: t.ts,
        kind: t.side === "buy" ? "whale_buy" : "whale_sell",
        text: `${t.side === "buy" ? "▲" : "▼"} ${fmtUsd(t.amountUsd)}`,
      }));
    return ms;
  }, [data]);

  if (!mint || error) {
    return <Empty>Token not found. <Link className="link" href="/tokens">Back to the radar.</Link></Empty>;
  }
  if (!data) return <Empty>ANALYZING TOKEN…</Empty>;

  const { info, snapshot: snap, signal, risk } = data;

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
              <Freshness ts={snap.ts} />
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
              <div className="text-[11.5px] dim leading-relaxed border-t border-[var(--border)] pt-2">
                {asking.answer}
                {asking.evidence?.slice(0, 4).map((e) => (
                  <div key={e.label} className="flex justify-between gap-2 mt-1 num text-[10.5px]">
                    <span className="faint">{e.label}</span>
                    <span>{e.value}</span>
                  </div>
                ))}
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

function HeaderStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="text-right">
      <div className="panel-title">{label}</div>
      <div className="mt-0.5">{children}</div>
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
