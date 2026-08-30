"use client";

import { useApi, fmtAgo, fmtNum } from "@/lib/client";
import { Empty, Stat } from "@/components/ui/bits";
import type { ProviderHealth } from "@/lib/types";

interface Status {
  providers: ProviderHealth[];
  engine: {
    version: string;
    tokens: number;
    wallets: number;
    historicalTrades: number;
    liveTrades: number;
    eventsBuffered: number;
    simulatedUntil: number;
    genesis: number;
    seed: number;
  };
  dataMode?: {
    overall: "live" | "mixed" | "demo";
    live: string[];
    simulated: string[];
    /** Real, and narrower than "live" would let a reader assume. */
    bounded?: string[];
  };
}

export default function StatusPage() {
  const { data, error } = useApi<Status>("/api/status", 8000);
  if (!data) return <Empty>{error ? "Status endpoint unavailable — retrying automatically." : "CHECKING PROVIDERS…"}</Empty>;

  return (
    <div className="p-3 flex flex-col gap-3">
      <h1 className="text-[15px] font-semibold tracking-wide">SYSTEM STATUS</h1>

      {/* Leads with the answer. The provider table below is the evidence, but a
          reader arriving from the data-source chip wants the one-line version
          of which half of this terminal is real. */}
      {data.dataMode && (
        <div className="panel px-3 py-2.5">
          <div className="panel-title pb-1">What is real right now</div>
          <div className="flex flex-wrap gap-1.5 items-center text-[12px]">
            {data.dataMode.live.map((c) => (
              <span key={c} className="chip chip-accent">
                {c}
              </span>
            ))}
            {data.dataMode.simulated.map((c) => (
              <span key={c} className="chip chip-warn">
                {c} · simulated
              </span>
            ))}
          </div>
          {/* The third column, spelled out rather than chipped. These are real
              measurements with a limit attached, and the limit is a sentence —
              "last ~48h only (public RPC retention)" does not fit in a chip and
              is the entire point of listing it. A capability that is real and
              narrow is the easiest kind to over-read. */}
          {data.dataMode.bounded && data.dataMode.bounded.length > 0 && (
            <div className="mt-2">
              <div className="panel-title pb-1">Real, with a limit worth knowing</div>
              <ul className="text-[11.5px] dim space-y-1">
                {data.dataMode.bounded.map((b) => (
                  <li key={b}>· {b}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="hint mt-2">
            {data.dataMode.overall === "mixed"
              ? "Mixed. Live panels carry the vendor's name; anything unlabelled is the deterministic simulator, " +
                "and a factor nobody could measure is dropped from a score rather than counted as zero."
              : data.dataMode.overall === "live"
                ? "Every capability is served by a live source."
                : "Nothing is live — the whole terminal is the deterministic simulator."}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
        <Stat label="Engine">v{data.engine.version}</Stat>
        <Stat label="Universe seed">{data.engine.seed}</Stat>
        <Stat label="Tokens">{data.engine.tokens}</Stat>
        <Stat label="Wallets">{data.engine.wallets}</Stat>
        <Stat label="Historical trades">{fmtNum(data.engine.historicalTrades)}</Stat>
        <Stat label="Live trades">{fmtNum(data.engine.liveTrades)}</Stat>
        <Stat label="Sim heartbeat">{fmtAgo(data.engine.simulatedUntil)}</Stat>
      </div>

      <div className="panel">
        <div className="panel-title px-3 pt-2.5 pb-1">Data providers</div>
        <table className="w-full text-[12px]">
          <thead className="thead">
            <tr>
              <th className="text-left px-3 py-1.5 font-medium">Provider</th>
              <th className="text-left px-2 font-medium">Mode</th>
              <th className="text-left px-2 font-medium">Status</th>
              <th className="text-right px-2 font-medium">Latency</th>
              <th className="text-right px-2 font-medium">Error rate</th>
              <th className="text-right px-2 font-medium">Last data</th>
              <th className="text-left px-3 font-medium">Note</th>
            </tr>
          </thead>
          <tbody className="num">
            {data.providers.map((p) => (
              <tr key={p.name} className="trow">
                <td className="px-3 py-2" style={{ fontFamily: "var(--font-sans)" }}>{p.name}</td>
                <td className="px-2">
                  <span className={`chip ${p.mode === "live" ? "chip-pos" : p.mode === "demo" ? "chip-accent" : ""}`}>{p.mode}</span>
                </td>
                {/* "not asked yet" is its own state and reads as such. A
                    provider that has answered nothing is not healthy, and it is
                    not offline either — the table used to call it "● ok" with
                    0ms and 0% errors, which is every enabled provider on a cold
                    load of this very page. */}
                <td className="px-2">
                  <span
                    className={
                      p.status === "ok"
                        ? "pos"
                        : p.status === "degraded"
                          ? "warn"
                          : p.status === "unknown"
                            ? "dim"
                            : "faint"
                    }
                    title={p.status === "unknown" ? "enabled, but nothing has been requested from it yet this session" : undefined}
                  >
                    {p.status === "ok"
                      ? "● ok"
                      : p.status === "degraded"
                        ? "● degraded"
                        : p.status === "unknown"
                          ? "◌ not asked yet"
                          : "○ offline"}
                  </span>
                </td>
                <td className="text-right px-2 dim" title={p.latencyMs === undefined ? "no request has completed" : undefined}>
                  {p.latencyMs === undefined ? "—" : `${p.latencyMs}ms`}
                </td>
                <td
                  className={`text-right px-2 ${p.errorRatePct !== undefined && p.errorRatePct > 5 ? "neg" : "dim"}`}
                  title={p.errorRatePct === undefined ? "no requests to compute a rate over" : undefined}
                >
                  {p.errorRatePct === undefined ? "—" : `${p.errorRatePct}%`}
                </td>
                <td className="text-right px-2 faint">{p.lastDataTs ? fmtAgo(p.lastDataTs) : "—"}</td>
                <td className="px-3 text-[11px] dim" style={{ fontFamily: "var(--font-sans)" }}>{p.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel p-3.5 text-[11.5px] dim leading-relaxed">
        <span className="panel-title block mb-1.5">Fallback chains</span>
        Token data: jupiter → birdeye → dexscreener → cached · Market data: birdeye → dexscreener → demo · Wallet activity:
        helius → demo · Labels: nansen → birdeye → demo · SOL reference price: coingecko ∥ cryptocom ∥ infstones (median,
        cross-checked) · Unconfigured providers fall back to the deterministic demo universe — never silently, always labeled.
      </div>
    </div>
  );
}
