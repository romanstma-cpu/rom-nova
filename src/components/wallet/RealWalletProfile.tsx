"use client";

// A real Solana wallet on screen.
//
// The layout is ordered by how much a reader can trust each block, worst
// first, which is backwards from every other tracker and deliberate. The
// coverage strip is at the TOP because every number under it is conditional on
// it: a realized-PnL figure over forty-eight hours is a completely different
// claim from a lifetime one, and putting the window in a footnote is how the
// two get confused.
//
// The other rule this file follows: a value that was not measured renders as
// UNMEASURED with the reason on hover, never as a dash that could pass for
// zero and never as a zero at all. Half the cells on a real wallet are like
// that, and pretending otherwise would make the other half worthless.

import Link from "next/link";
import { fmtUsd, fmtAgo, shortAddr } from "@/lib/client";
import { Stat, Empty } from "@/components/ui/bits";
import type { WalletFill, WalletHolding, WalletProfile } from "@/lib/types";

/** A measured value, or an explicit statement that nobody measured it. */
function Measured({
  value,
  render,
  why,
}: {
  value: number | undefined;
  render: (v: number) => React.ReactNode;
  why: string;
}) {
  if (value === undefined) {
    return (
      <span className="faint text-[12px] cursor-help" title={why}>
        UNMEASURED
      </span>
    );
  }
  return <>{render(value)}</>;
}

const pnlClass = (x: number): string => (x >= 0 ? "pos" : "neg");

function CoverageStrip({ p }: { p: WalletProfile }) {
  const c = p.coverage;
  const window =
    c.windowHours >= 1 ? `${c.windowHours.toFixed(1)} hours` : `${Math.round(c.windowHours * 60)} minutes`;
  return (
    <div className="panel px-4 py-3" style={{ borderColor: "var(--warn, #b8860b)" }}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="chip chip-warn">WINDOW · NOT LIFETIME</span>
        <span className="text-[12.5px]">
          Everything below covers <b className="num">{window}</b> — {c.transactionsRead} transactions
          {c.signaturesListed > c.transactionsRead ? ` of ${c.signaturesListed} listed` : ""}, read from{" "}
          {c.source}.
        </span>
      </div>
      <div className="text-[11.5px] dim mt-1.5 num">
        {new Date(c.oldestTs).toLocaleString()} → {new Date(c.newestTs).toLocaleString()}
      </div>
      <div className="text-[11.5px] faint mt-1">{c.note}</div>
      {c.transactionsFailed > 0 && (
        <div className="text-[11.5px] mt-1 neg">
          {c.transactionsRefused > 0
            ? `${c.transactionsRefused} transactions were refused by the public RPC's rate limit — reload shortly for a complete read.`
            : `${c.transactionsFailed} transactions could not be read; their fills are missing from every figure here.`}
        </div>
      )}
    </div>
  );
}

function PositionRow({ h }: { h: WalletHolding }) {
  return (
    <tr className="trow">
      <td className="px-3 py-1.5">
        <Link href={`/token?m=${h.mint}`} className="hover:text-[var(--accent)] num text-[11.5px]">
          {h.symbol ?? shortAddr(h.mint)}
        </Link>
      </td>
      <td className="text-right px-2 dim">
        {h.tokens.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </td>
      <td className="text-right px-2">
        <Measured
          value={h.valueUsd}
          render={(v) => <span>{fmtUsd(v)}</span>}
          why="no price published for this mint, or the price budget was spent on larger positions"
        />
      </td>
      <td className="text-right px-2 dim">
        <Measured
          value={h.costBasisUsd}
          render={(v) => <span>{fmtUsd(v)}</span>}
          why={h.reason ?? "entry not observed"}
        />
      </td>
      <td className="text-right px-3">
        {h.costBasisKnown ? (
          <Measured
            value={h.unrealizedPnlUsd}
            render={(v) => (
              <span className={pnlClass(v)}>
                {fmtUsd(v)}
                {h.unrealizedPnlPct !== undefined && (
                  <span className="faint"> ({h.unrealizedPnlPct.toFixed(0)}%)</span>
                )}
              </span>
            )}
            why="the position has a cost basis but no current price"
          />
        ) : (
          <span className="faint text-[11px] cursor-help" title={h.reason}>
            COST UNKNOWN
          </span>
        )}
      </td>
    </tr>
  );
}

function FillRow({ f }: { f: WalletFill }) {
  const unpriced = f.priceUsd === undefined;
  return (
    <tr className="trow">
      <td className="px-3 py-1 faint">{new Date(f.ts).toLocaleString()}</td>
      <td className={`px-2 ${unpriced ? "faint" : f.side === "buy" ? "pos" : "neg"}`}>
        {/* IN/OUT rather than BUY/SELL when nothing was paid: tokens arriving
            by airdrop or by someone else's purchase are not a buy. */}
        {unpriced ? (f.side === "buy" ? "IN" : "OUT") : f.side.toUpperCase()}
      </td>
      <td className="px-2">
        <Link href={`/token?m=${f.mint}`} className="hover:text-[var(--accent)]">
          {shortAddr(f.mint)}
        </Link>
      </td>
      <td className="px-2 dim">{f.tokens.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
      <td className="px-2">
        {unpriced ? (
          <span className="faint cursor-help" title={f.unpricedReason}>
            no price observed
          </span>
        ) : (
          <span>{fmtUsd(f.valueUsd)}</span>
        )}
      </td>
      <td className="px-2 faint">
        {f.quoteAmount !== undefined
          ? `${f.quoteAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${
              f.quoteMint === "So11111111111111111111111111111111111111112" ? "SOL" : shortAddr(f.quoteMint ?? "")
            }`
          : "—"}
      </td>
      <td className="px-2 faint text-right">
        <a
          href={`https://solscan.io/tx/${f.signature}`}
          target="_blank"
          rel="noreferrer"
          className="hover:text-[var(--accent)]"
          title={f.signature}
        >
          {f.signature.slice(0, 8)}…
        </a>
      </td>
    </tr>
  );
}

const UNMEASURED_COPY: Record<string, string> = {
  lifetimeHistory:
    "lifetime history — no keyless source has it; the only public RPC that answers retains about two days",
  reputation: "wallet reputation — nothing keyless carries one, and two days of trades is a sample, not a record",
  costBasis: "cost basis on some positions — acquired outside the window or without an observable price",
  realizedPnl: "part of realized PnL — some sells had no observed buy and are excluded rather than counted as profit",
  fillPrice: "the price of some movements — tokens moved with no quote leg belonging to this wallet",
};

export function RealWalletProfile({ p }: { p: WalletProfile }) {
  const s = p.stats;
  const withValue = p.positions.filter((x) => (x.valueUsd ?? 0) > 0.01 || x.costBasisKnown);

  return (
    <div className="flex flex-col gap-3">
      <div className="panel px-4 py-3 flex items-start gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] font-semibold num">{shortAddr(p.address)}</span>
            <span className="chip chip-accent">REAL · SOLANA</span>
            {/* No labels. The demo universe minted "smart trader" and "insider"
                tags; nothing keyless publishes wallet reputation, so a real
                wallet wears none rather than an invented one. */}
            <span className="chip faint" title="no keyless source publishes wallet labels or reputation">
              no labels available
            </span>
          </div>
          <button
            className="num text-[10.5px] faint hover:text-[var(--accent)] mt-1 break-all text-left"
            onClick={() => navigator.clipboard?.writeText(p.address)}
          >
            {p.address} ⧉
          </button>
          {p.holdings && (
            <div className="text-[10.5px] faint num mt-0.5">
              {p.holdings.solBalance.toFixed(3)} SOL · {p.holdings.mints} token positions ·{" "}
              {p.holdings.pricedMints} priced
              {p.holdings.unpricedMints > 0 && `, ${p.holdings.unpricedMints} without a published price`}
            </div>
          )}
        </div>
        <div className="ml-auto text-right">
          <div className="panel-title">Portfolio value (priced positions)</div>
          <div className="num text-[20px] mt-1">
            {p.holdings ? fmtUsd(p.holdings.valuedUsd) : <span className="faint text-[12px]">UNMEASURED</span>}
          </div>
          <a
            href={`https://solscan.io/account/${p.address}`}
            target="_blank"
            rel="noreferrer"
            className="link text-[10.5px]"
          >
            verify on solscan ↗
          </a>
        </div>
      </div>

      <CoverageStrip p={p} />

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
        <Stat label="Realized PnL" sub="over the window above">
          <Measured
            value={s.realizedPnlUsd}
            render={(v) => <span className={pnlClass(v)}>{fmtUsd(v)}</span>}
            why="no round trip closed inside the readable window — a zero here would mean 'traded and broke even', which is not what happened"
          />
        </Stat>
        <Stat label="Unrealized PnL" sub="reconciled positions only">
          <Measured
            value={s.unrealizedPnlUsd}
            render={(v) => <span className={pnlClass(v)}>{fmtUsd(v)}</span>}
            why="no position's entry was fully observed, so no cost basis is knowable"
          />
        </Stat>
        <Stat label="Win rate" sub={`${s.roundTrips} round trips`}>
          <Measured
            value={s.winRate}
            render={(v) => <span>{(v * 100).toFixed(0)}%</span>}
            why="no completed round trip in the window"
          />
        </Stat>
        <Stat label="Profit factor">
          <Measured
            value={s.profitFactor}
            render={(v) => <span>{v >= 99 ? "∞" : v.toFixed(2)}</span>}
            why="no completed round trip in the window"
          />
        </Stat>
        <Stat label="Median hold">
          <Measured
            value={s.medianHoldHours}
            render={(v) => <span>{v < 1 ? `${Math.round(v * 60)}m` : `${v.toFixed(1)}h`}</span>}
            why="no completed round trip in the window"
          />
        </Stat>
        <Stat label="Fills" sub={`${s.buys} in · ${s.sells} out · ${s.distinctMints} tokens`}>
          {s.pricedFills + s.unpricedFills}
        </Stat>
        <Stat
          label="Priced"
          sub={s.unpricedFills > 0 ? `${s.unpricedFills} without an observable price` : "every movement priced"}
        >
          {s.pricedFills + s.unpricedFills > 0
            ? `${Math.round((s.pricedFills / (s.pricedFills + s.unpricedFills)) * 100)}%`
            : "—"}
        </Stat>
      </div>

      <div className="panel px-4 py-3">
        <div className="panel-title mb-1.5">What this read could not establish</div>
        <ul className="text-[11.5px] dim space-y-1">
          {p.unmeasured.map((u) => (
            <li key={u}>· {UNMEASURED_COPY[u] ?? u}</li>
          ))}
        </ul>
        <div className="panel-title mt-3 mb-1.5">Where each number came from</div>
        <ul className="text-[11.5px] faint space-y-1">
          {p.provenance.map((line, i) => (
            <li key={i}>· {line}</li>
          ))}
        </ul>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">
            Open positions
            <span className="faint"> — balances read from the chain, cost basis only where the entry was seen</span>
          </div>
          <div className="max-h-[340px] overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead className="thead">
                <tr>
                  <th className="text-left px-3 py-1.5 font-medium">Token</th>
                  <th className="text-right px-2 font-medium">Tokens</th>
                  <th className="text-right px-2 font-medium">Value</th>
                  <th className="text-right px-2 font-medium">Cost</th>
                  <th className="text-right px-3 font-medium">Unrealized</th>
                </tr>
              </thead>
              <tbody className="num">
                {withValue.map((h) => (
                  <PositionRow key={h.mint} h={h} />
                ))}
              </tbody>
            </table>
            {withValue.length === 0 && <Empty>No positions with a readable value.</Empty>}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">
            Closed round trips
            <span className="faint"> — entry and exit both observed</span>
          </div>
          <div className="max-h-[340px] overflow-y-auto">
            <table className="w-full text-[12px]">
              <tbody className="num">
                {p.roundTrips.map((r, i) => (
                  <tr key={i} className="trow">
                    <td className="px-3 py-1.5">
                      <Link href={`/token?m=${r.mint}`} className="hover:text-[var(--accent)] text-[11.5px]">
                        {r.symbol ?? shortAddr(r.mint)}
                      </Link>
                    </td>
                    <td className="text-right px-2 dim">{fmtUsd(r.costUsd)} in</td>
                    <td className={`text-right px-2 ${pnlClass(r.pnlUsd)}`}>{fmtUsd(r.pnlUsd)}</td>
                    <td className="text-right px-2 dim">
                      {r.holdHours < 1 ? `${Math.round(r.holdHours * 60)}m` : `${r.holdHours.toFixed(1)}h`} held
                    </td>
                    <td className="text-right px-3 faint">{fmtAgo(r.exitTs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {p.roundTrips.length === 0 && (
              <Empty>
                Nothing bought AND sold inside this window. Round trips are the only trades whose profit is
                computable here.
              </Empty>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title px-3 pt-2.5 pb-1">
          Movements
          <span className="faint"> — every token change this wallet made, priced or not</span>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-[11.5px]">
            <thead className="thead">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">When</th>
                <th className="text-left px-2 font-medium">Dir</th>
                <th className="text-left px-2 font-medium">Token</th>
                <th className="text-left px-2 font-medium">Tokens</th>
                <th className="text-left px-2 font-medium">Value</th>
                <th className="text-left px-2 font-medium">Paid / received</th>
                <th className="text-right px-2 font-medium">Tx</th>
              </tr>
            </thead>
            <tbody className="num">
              {p.fills.map((f, i) => (
                <FillRow key={`${f.signature}-${f.mint}-${i}`} f={f} />
              ))}
            </tbody>
          </table>
          {p.fills.length === 0 && <Empty>No token movements inside the readable window.</Empty>}
        </div>
      </div>
    </div>
  );
}
