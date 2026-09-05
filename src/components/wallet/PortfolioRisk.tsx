"use client";

// Risk, read-only, and the FIFO export: the two things a reader with their
// own address pasted in wanted from a "portfolio" and the app did not have.
//
// Nothing here connects a wallet. The address is public, the balances are
// the chain's, the fills are what one read returned, and the CSV is the
// FIFO estimate over those fills with its blanks explained per row. The
// word "estimate" is on the button, in the file name and under the panel,
// because a spreadsheet opened in April will not remember this paragraph.

import { useMemo, useState, useSyncExternalStore } from "react";
import { fmtUsd } from "@/lib/client";
import { fifoRows } from "@/lib/portfolio/fifo";
import { fifoCsv, fifoCsvName } from "@/lib/portfolio/csv";
import { portfolioRisk } from "@/lib/portfolio/risk";
import { myWalletServer, myWalletSnapshot, setMyWallet, subscribeMyWallet } from "@/lib/portfolio/mine";
import type { WalletProfile } from "@/lib/types";

const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);

function Cell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="panel-title">{label}</div>
      <div className="num text-[15px] mt-0.5 truncate">{value}</div>
      {sub && <div className="text-[10.5px] faint truncate">{sub}</div>}
    </div>
  );
}

export function PortfolioRisk({ p }: { p: WalletProfile }) {
  const mine = useSyncExternalStore(subscribeMyWallet, myWalletSnapshot, myWalletServer);
  const [exported, setExported] = useState<string | null>(null);
  const risk = portfolioRisk(p);
  const reading = p.stage === "balances";

  // Symbols for the CSV come from the same profile, by mint.
  const fifo = useMemo(() => {
    const symbols = new Map<string, string>();
    for (const x of p.positions) if (x.symbol) symbols.set(x.mint, x.symbol);
    for (const r of p.roundTrips) if (r.symbol) symbols.set(r.mint, r.symbol);
    return fifoRows(p.fills, (m) => symbols.get(m));
  }, [p.fills, p.positions, p.roundTrips]);
  const s = fifo.summary;

  const exportCsv = () => {
    const blob = new Blob([fifoCsv(fifo.rows)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fifoCsvName(p.address);
    a.click();
    URL.revokeObjectURL(a.href);
    setExported(a.download);
  };

  const isMine = mine === p.address;

  return (
    <div className="panel p-3.5 flex flex-col gap-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="panel-title">Risk · read-only</span>
        {risk && (
          <span className={`chip text-[9.5px] ${risk.reading === "one bet" ? "chip-danger" : risk.reading === "concentrated" ? "chip-warn" : ""}`}>
            {risk.reading.toUpperCase()}
          </span>
        )}
        {isMine && <span className="chip chip-accent text-[9.5px]">MY WALLET</span>}
        <span className="ml-auto flex items-center gap-2">
          <button type="button" className="btn text-[11px]" onClick={() => setMyWallet(isMine ? null : p.address)} title="Remembered in this browser as an address only — no key, no connection.">
            {isMine ? "forget it is mine" : "this is my wallet"}
          </button>
          <button type="button" className="btn text-[11px]" onClick={exportCsv} disabled={reading || fifo.rows.length === 0} title="One row per fill, FIFO cost basis on sells, blanks explained per row.">
            {reading ? "READING TRADES…" : "EXPORT FIFO CSV · estimate"}
          </button>
        </span>
      </div>

      {risk ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Cell label="Top position" value={risk.top1 ? pct(risk.top1.pct) : "—"} sub={risk.top1 ? `${risk.top1.symbol || risk.top1.mint.slice(0, 6)} · ${fmtUsd(risk.top1.valueUsd)} of tokens` : "no priced tokens"} />
          <Cell label="Top three" value={pct(risk.top3Pct)} sub="of token value" />
          <Cell label="In SOL" value={pct(risk.solPct)} sub={risk.solValueUsd !== null ? fmtUsd(risk.solValueUsd) : "not valued"} />
          <Cell label="Cost unknown" value={pct(risk.unknownCostPct)} sub="of token value, bought unseen" />
          <Cell label="Positions" value={String(risk.positions)} sub={`${risk.unpricedMints} unpriced · ${risk.dust} dust`} />
          <Cell label="Valued" value={fmtUsd(risk.valuedUsd)} sub={`${fmtUsd(risk.tokenValueUsd)} tokens`} />
        </div>
      ) : (
        <div className="text-[11.5px] faint">Balances were not read for this wallet, so there is nothing to measure risk on.</div>
      )}
      {risk && risk.notes.length > 0 && (
        <ul className="text-[10.5px] dim leading-relaxed list-disc pl-4">
          {risk.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      <div className="text-[11px] dim leading-relaxed border-t border-[rgba(27,35,51,0.5)] pt-2">
        <span className="panel-title mr-2">FIFO over this read</span>
        {reading ? (
          <span className="faint">waiting for the transaction history…</span>
        ) : s.sells === 0 ? (
          <span className="faint">{s.buys} buy{s.buys === 1 ? "" : "s"}, no sells inside the readable window — nothing realized to estimate.</span>
        ) : (
          <>
            <span className="num">{s.sells}</span> sells: <span className="num">{s.matchedSells}</span> matched to observed lots
            {s.partlyMatchedSells > 0 && (
              <>
                , <span className="num">{s.partlyMatchedSells}</span> in part
              </>
            )}
            {s.unmatchedSells > 0 && (
              <>
                , <span className="num">{s.unmatchedSells}</span> from lots never seen (excluded)
              </>
            )}
            {s.unpricedSells > 0 && (
              <>
                , <span className="num">{s.unpricedSells}</span> unpriced
              </>
            )}

            {s.matchedSells + s.partlyMatchedSells === 0 ? (
              <>. Nothing to realize: no sell here came from a lot this read saw bought.</>
            ) : s.matchedSells + s.partlyMatchedSells === s.unpricedSells + s.unknownCostSells ? (
              <>. Nothing priced on both sides, so no realized figure is claimed.</>
            ) : (
              <>
                . Realized on the matched, priced sells: <span className={`num ${s.realizedPnlUsd >= 0 ? "pos" : "neg"}`}>{fmtUsd(s.realizedPnlUsd)}</span>
                {(s.longTermPnlUsd !== 0 || s.shortTermPnlUsd !== 0) && (
                  <span className="faint">
                    {" "}
                    ({fmtUsd(s.shortTermPnlUsd)} under a year, {fmtUsd(s.longTermPnlUsd)} over)
                  </span>
                )}
                .
              </>
            )}
          </>
        )}
        {exported && <span className="faint"> Saved {exported}.</span>}
      </div>
      <div className="text-[10px] faint leading-relaxed">
        An estimate in USD at the prices this read observed, over the fills it could see, FIFO by mint. Not a tax document,
        not advice; the coverage strip above says how much of this wallet&apos;s history that is.
      </div>
    </div>
  );
}
