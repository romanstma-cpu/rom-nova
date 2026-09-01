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
import { movementLabel } from "@/lib/engine/fill-label";

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

/**
 * The window, the age, and the difference between them.
 *
 * `new Date(0)` renders as "12/31/1969", which is what a zero-transaction
 * wallet showed. A timestamp that was never measured is not a date and must
 * not be formatted as one.
 */
const stamp = (ts: number): string => (ts > 0 ? new Date(ts).toLocaleString() : "—");

/**
 * A token amount at the precision the amount deserves.
 *
 * A flat `maximumFractionDigits: 2` rendered a 0.0016 cbBTC position as "0"
 * tokens beside "$173.84" — a zero standing in for a real balance, which is
 * this codebase's one forbidden rendering. Small amounts get enough digits to
 * be non-zero; large ones keep the readable two.
 */
export const fmtTokens = (n: number): string => {
  const abs = Math.abs(n);
  if (n === 0) return "0";
  if (abs >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 0.001) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  // Below what eight fraction digits can show, exponential — a real 5.2e-9
  // balance rounded to "0" at this tier, the same forbidden zero one tier up.
  if (abs < 1e-8) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
};

function CoverageStrip({ p }: { p: WalletProfile }) {
  const c = p.coverage;
  const window =
    c.windowHours >= 1 ? `${c.windowHours.toFixed(1)} hours` : `${Math.round(c.windowHours * 60)} minutes`;
  const noFills = c.transactionsRead === 0;
  return (
    <div className="panel px-4 py-3" style={{ borderColor: "var(--warn, #b8860b)" }}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="chip chip-warn">FILL WINDOW · NOT LIFETIME</span>
        <span className="text-[12.5px]">
          {p.stage === "balances" ? (
            <>Balances are live. The trade history is still being read…</>
          ) : noFills ? (
            <>No transactions were readable for this address.</>
          ) : (
            <>
              Prices and PnL below cover <b className="num">{window}</b> — {c.transactionsRead} transactions
              {c.signaturesListed > c.transactionsRead ? ` of ${c.signaturesListed} listed` : ""}, read from{" "}
              {c.source}.
            </>
          )}
        </span>
      </div>
      {!noFills && (
        <div className="text-[11.5px] dim mt-1.5 num">
          {stamp(c.oldestTs)} → {stamp(c.newestTs)}
        </div>
      )}

      {/* The wallet's real AGE, which is a different and much longer number
          wherever the archival index is reachable. Withholding it made a
          two-year-old whale and a 33-minute-old wallet look identical. */}
      {c.indexArchival && c.firstSeenTs > 0 && (
        <div className="text-[11.5px] mt-1.5">
          <span className="chip chip-accent mr-1.5">AGE</span>
          {c.indexComplete ? (
            <>
              <b className="num">{c.signaturesListed.toLocaleString()}</b> transactions in total, first on{" "}
              <span className="num">{new Date(c.firstSeenTs).toLocaleDateString()}</span> —{" "}
              <b className="num">{c.historyDays.toFixed(0)} days</b> old.
            </>
          ) : (
            <>
              at least <b className="num">{c.signaturesListed.toLocaleString()}</b> transactions, active since at
              least <span className="num">{new Date(c.firstSeenTs).toLocaleDateString()}</span> (index page cap
              reached — it is older than this).
            </>
          )}
        </div>
      )}
      {!c.indexArchival && c.runtime === "browser" && (
        <div className="text-[11.5px] mt-1.5 faint">
          Wallet age is not readable from a browser: the archival index refuses any request carrying an Origin
          header, which a tab cannot omit. The desktop app reads it.
        </div>
      )}

      <div className="text-[11.5px] faint mt-1">{c.note}</div>
      {c.transactionsRefused > 0 && (
        <div className="text-[11.5px] mt-1 neg">
          {c.transactionsRefused} transactions were refused by the public RPC&apos;s rate limit — reload shortly
          for a complete read.
        </div>
      )}
      {c.transactionsFailed - c.transactionsRefused > 0 && (
        <div className="text-[11.5px] mt-1 neg">
          {c.transactionsFailed - c.transactionsRefused} transactions could not be read; their fills are missing
          from every figure here.
        </div>
      )}
    </div>
  );
}

/**
 * A refusal to profile, with somewhere useful to go.
 *
 * Pasting a token mint used to render "$520.8K portfolio, 144 positions" — the
 * mint's own liquidity, presented as a trader's book.
 */
function NotAWallet({ p }: { p: WalletProfile }) {
  return (
    <div className="panel px-4 py-6 text-center">
      <div className="flex items-center gap-2 justify-center flex-wrap">
        <span className="chip chip-warn">{p.identity.kind.replace("-", " ").toUpperCase()}</span>
        <span className="num text-[13px]">{shortAddr(p.address)}</span>
      </div>
      <div className="text-[12.5px] mt-2 max-w-[560px] mx-auto">{p.identity.detail}</div>
      <div className="mt-3 flex gap-2 justify-center flex-wrap">
        {p.identity.kind === "mint" && (
          <Link href={`/token?m=${p.address}`} className="chip chip-accent">
            open the token page instead →
          </Link>
        )}
        {/* The owning wallet was named in prose and left unlinked — the one
            useful next step from a token-account page, as a copy-paste job. */}
        {p.identity.kind === "token-account" && p.identity.holder && (
          <Link href={`/whale?a=${p.identity.holder}`} className="chip chip-accent">
            profile the wallet that owns it →
          </Link>
        )}
        <a
          href={`https://solscan.io/account/${p.address}`}
          target="_blank"
          rel="noreferrer"
          className="chip"
        >
          view on solscan ↗
        </a>
      </div>
    </div>
  );
}

/**
 * The assets a swap is denominated IN, which are not positions.
 *
 * Wrapped SOL and the stablecoins are what a trader pays with, so listing them
 * beside the tokens they bought reads as though the wallet were long its own
 * cash. They stay in the table — the balance is real and worth seeing — under a
 * label that says which they are.
 */
const QUOTE_ASSETS: Record<string, string> = {
  So11111111111111111111111111111111111111112: "wSOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

function PositionRow({ h }: { h: WalletHolding }) {
  const quote = QUOTE_ASSETS[h.mint];
  return (
    <tr className="trow">
      <td className="px-3 py-1.5">
        <Link href={`/token?m=${h.mint}`} className="hover:text-[var(--accent)] num text-[11.5px]">
          {h.symbol ?? quote ?? shortAddr(h.mint)}
        </Link>
        {/* Real whitespace, not margin: without it copied text reads "USDCcash". */}
        {quote && " "}
        {quote && (
          <span className="chip ml-1.5 faint" title="a quote asset — what this wallet trades WITH, not a position it took">
            cash
          </span>
        )}
      </td>
      <td className="text-right px-2 dim">{fmtTokens(h.tokens)}</td>
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
        {/* The shared label, so this cell and an alert about the same fill can
            never disagree. Testing `priceUsd === undefined` here (which is what
            this cell used to do) called a real swap with no SOL/USD bar a
            transfer, while the alert called it a sale. */}
        {movementLabel(f).short}
      </td>
      <td className="px-2">
        <Link href={`/token?m=${f.mint}`} className="hover:text-[var(--accent)]">
          {shortAddr(f.mint)}
        </Link>
      </td>
      <td className="px-2 dim">{fmtTokens(f.tokens)}</td>
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
    "lifetime PnL — the only endpoint that still serves transactions older than ~2 days allows ten of " +
    "them per minute, so the fills here are a recent window however old the wallet is",
  reputation:
    "wallet reputation — nothing keyless publishes one. Entity labels are not available either: " +
    "Solscan's account API needs a key, and the one free source returns .sol domains that anyone can " +
    "point at anyone's address",
  costBasis: "cost basis on some positions — acquired outside the window or without an observable price",
  realizedPnl: "part of realized PnL — some sells had no observed buy and are excluded rather than counted as profit",
  // Not "no quote leg": an LP deposit reaches this state BECAUSE the quote leg
  // moved, and a swap with no SOL/USD bar had one all along. The count is
  // every movement without a price; the causes differ and each fill names its
  // own.
  fillPrice: "the price of some movements — see each fill's own reason",
};

export function RealWalletProfile({ p }: { p: WalletProfile }) {
  const s = p.stats;
  const withValue = p.positions.filter((x) => (x.valueUsd ?? 0) > 0.01 || x.costBasisKnown);
  const reading = p.stage === "balances";
  const totalFills = s.pricedFills + s.unpricedFills;

  if (!p.identity.profilable) return <NotAWallet p={p} />;

  return (
    <div className="flex flex-col gap-3">
      <div className="panel px-4 py-3 flex items-start gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] font-semibold num">{shortAddr(p.address)}</span>
            <span className="chip chip-accent">REAL · SOLANA</span>
            {/* Account TYPE is a chain fact and is shown. Entity IDENTITY is
                somebody's database and there is no keyless one — measured:
                Solscan 401/403, SolanaFM 502, Helius key-gated. The only free
                source returns .sol domains that any third party can point at
                any address, which would let an attacker label a drainer
                "Binance" inside this app. */}
            <span
              className="chip faint cursor-help"
              title={
                "No entity labels: Solscan's account API returns 401 without a key and 403 to any origin " +
                "but its own, SolanaFM is down, and Helius needs a key. The one free source (SNS reverse " +
                "lookup) returns .sol domains that anyone can point at anyone's address — asked about " +
                "Binance's hot wallet it answers 'cif', 'kiing'. Unusable as identity."
              }
            >
              no entity label (none published keylessly)
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
              {p.holdings.solBalance.toLocaleString(undefined, { maximumFractionDigits: 3 })} SOL ·{" "}
              {p.holdings.mints} token positions · {p.holdings.pricedMints} priced
              {p.holdings.unpricedMints > 0 && `, ${p.holdings.unpricedMints} without a published price`}
            </div>
          )}
        </div>
        <div className="ml-auto text-right">
          <div className="panel-title">Portfolio value</div>
          <div className="num text-[20px] mt-1">
            {p.holdings ? fmtUsd(p.holdings.valuedUsd) : <span className="faint text-[12px]">UNMEASURED</span>}
          </div>
          {/* Split out because omitting native SOL understated one wallet by
              52%: $162.20M of tokens beside 1,661,879 SOL worth $174.9M more. */}
          {p.holdings && (
            <div className="text-[10.5px] faint num">
              {fmtUsd(p.holdings.tokenValueUsd)} tokens
              {p.holdings.solValueUsd !== undefined
                ? ` + ${fmtUsd(p.holdings.solValueUsd)} in SOL`
                : " · SOL not valued (no price)"}
            </div>
          )}
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

      {reading && (
        <div className="panel px-4 py-2.5 text-[12px]">
          <span className="chip chip-accent mr-2">READING TRADES…</span>
          Balances above are live. Every figure below needs the transaction history, which takes a few seconds —
          they are blank because nothing has been measured yet, not because the answer is zero.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
        <Stat
          label="Realized PnL"
          sub={
            s.partialExits > 0
              ? `${s.roundTrips} full closes + ${s.partialExits} partial exits`
              : "over the fill window above"
          }
        >
          <Measured
            value={reading ? undefined : s.realizedPnlUsd}
            render={(v) => <span className={pnlClass(v)}>{fmtUsd(v)}</span>}
            why={
              reading
                ? "the trade history has not been read yet"
                : "no priced sell landed inside the readable window — a zero here would mean 'traded and broke even', which is not what happened"
            }
          />
        </Stat>
        <Stat label="Unrealized PnL" sub="reconciled positions only">
          <Measured
            value={reading ? undefined : s.unrealizedPnlUsd}
            render={(v) => <span className={pnlClass(v)}>{fmtUsd(v)}</span>}
            why={
              reading
                ? "the trade history has not been read yet"
                : "no position's entry was fully observed, so no cost basis is knowable"
            }
          />
        </Stat>
        {/* These three come from FULL CLOSES only, while realized PnL above
            counts partial exits too. Same screen, different denominators —
            labelled here rather than left for a reader to reconcile. */}
        <Stat label="Win rate" sub={`${s.roundTrips} full closes only`}>
          <Measured
            value={reading ? undefined : s.winRate}
            render={(v) => <span>{(v * 100).toFixed(0)}%</span>}
            why={reading ? "the trade history has not been read yet" : "no position was fully closed in the window"}
          />
        </Stat>
        <Stat label="Profit factor" sub="full closes only">
          <Measured
            value={reading ? undefined : s.profitFactor}
            render={(v) => <span>{v >= 99 ? "∞" : v.toFixed(2)}</span>}
            why={reading ? "the trade history has not been read yet" : "no position was fully closed in the window"}
          />
        </Stat>
        <Stat label="Median hold" sub="full closes only">
          <Measured
            value={reading ? undefined : s.medianHoldHours}
            render={(v) => <span>{v < 1 ? `${Math.round(v * 60)}m` : `${v.toFixed(1)}h`}</span>}
            why={reading ? "the trade history has not been read yet" : "no position was fully closed in the window"}
          />
        </Stat>
        <Stat label="Movements" sub={`${s.buys} in · ${s.sells} out · ${s.distinctMints} tokens`}>
          {reading ? <span className="faint text-[12px]">READING…</span> : totalFills}
        </Stat>
        {/* The zero case used to fall through to "every movement priced",
            which is true of an empty set and reads as a clean bill of health.
            Hit on three of eight wallets in the blind review. */}
        <Stat
          label="Priced"
          sub={
            reading
              ? "the trade history has not been read yet"
              : totalFills === 0
                ? "nothing to price"
                : s.unpricedFills > 0
                  ? `${s.unpricedFills} without an observable price`
                  : "every movement priced"
          }
        >
          {reading || totalFills === 0 ? (
            <span className="faint text-[12px]">{reading ? "READING…" : "N/A"}</span>
          ) : (
            `${Math.round((s.pricedFills / totalFills) * 100)}%`
          )}
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
            <span className="faint"> — full closes only</span>
          </div>
          {/* Why this table does not add up to the headline. A sell that trims
              a position books real PnL and never closes anything, so it belongs
              in one figure and not the other. */}
          {s.partialExits > 0 && (
            <div className="px-3 pb-1.5 text-[11px] faint">
              Realized PnL above also includes {s.partialExits} partial exit
              {s.partialExits === 1 ? "" : "s"} worth{" "}
              <span className={pnlClass(s.partialExitPnlUsd)}>{fmtUsd(s.partialExitPnlUsd)}</span>, which trimmed
              positions without closing them and so appear in no row here.
            </div>
          )}
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
