// Research assistant. Answers come from structured queries against the
// store — every claim carries the data it stands on. No language model is
// required; when one is configured it can phrase these same facts, but the
// retrieval layer is the source of truth either way.

import type { DemoStore } from "../demo/store";
import { HOUR, DAY } from "../demo/universe";
import { computeSignal, signalsAt } from "./signals";
import { findSimilar } from "./similarity";
import { buildTokenRows } from "../api/rows";
import { shortAddr } from "../demo/rng";

export interface ResearchAnswer {
  question: string;
  answer: string;
  evidence: { label: string; value: string }[];
  sources: { name: string; ts: number }[];
  links: { label: string; href: string }[];
}

const usd = (x: number) =>
  `${x < 0 ? "-" : ""}$${Math.abs(x) >= 1e6 ? (Math.abs(x) / 1e6).toFixed(2) + "M" : Math.abs(x) >= 1e3 ? (Math.abs(x) / 1e3).toFixed(1) + "K" : Math.abs(x).toFixed(0)}`;

function resolveToken(store: DemoStore, q: string) {
  const words = q.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 3);
  for (const tok of store.tokenList()) {
    if (words.includes(tok.info.symbol.toUpperCase())) return tok;
    if (q.includes(tok.info.mint)) return tok;
  }
  return undefined;
}

export function answerQuestion(store: DemoStore, question: string): ResearchAnswer {
  const q = question.toLowerCase();
  const now = store.simulatedUntil;
  const tok = resolveToken(store, question);
  const sources = [{ name: "demo-universe (synthetic)", ts: now }];
  const mk = (answer: string, evidence: ResearchAnswer["evidence"], links: ResearchAnswer["links"] = []): ResearchAnswer => ({
    question,
    answer,
    evidence,
    sources,
    links,
  });

  // "why is X rising / moving / ranked"
  if (tok && /(why|explain|reason|moving|rising|pumping|ranked|score)/.test(q)) {
    const sig = computeSignal(store, tok.info.mint, now);
    if (sig) {
      const top = sig.factors.filter((f) => f.weight > 0).sort((a, b) => b.contribution - a.contribution).slice(0, 5);
      return mk(
        `${tok.info.symbol} currently scores ${sig.score}/100 (${sig.label}, confidence ${(sig.confidence * 100).toFixed(0)}%). The strongest measured drivers, in order: ${top.map((f) => f.name.toLowerCase()).join(", ")}. Bear case: ${sig.bearCase[0] ?? "none flagged"}.`,
        top.map((f) => ({ label: f.name, value: f.explanation })),
        [{ label: `Open ${tok.info.symbol}`, href: `/token?m=${tok.info.mint}` }, { label: "Open signal", href: `/signal?id=${sig.id}` }],
      );
    }
  }

  // "which wallets are buying X" / "who is accumulating"
  if (tok && /(wallet|who|whale|accumulat|buying)/.test(q)) {
    const trades = store.mintTrades(tok.info.mint, now - 24 * HOUR, now);
    const byWallet = new Map<string, number>();
    for (const t of trades) byWallet.set(t.wallet, (byWallet.get(t.wallet) ?? 0) + (t.side === "buy" ? t.amountUsd : -t.amountUsd));
    const buyers = [...byWallet.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return mk(
      buyers.length
        ? `${buyers.length} tracked wallets are net buyers of ${tok.info.symbol} over the last 24h, led by ${buyers
            .slice(0, 3)
            .map(([a, v]) => `${store.wallet(a)?.knownEntity ?? shortAddr(a)} (${usd(v)})`)
            .join(", ")}.`
        : `No tracked wallet has been a net buyer of ${tok.info.symbol} in the last 24h.`,
      buyers.map(([a, v]) => ({
        label: store.wallet(a)?.knownEntity ?? shortAddr(a),
        value: `net ${usd(v)} · smart-money ${store.wallet(a)?.smartMoney.total ?? "?"}/100`,
      })),
      buyers.map(([a]) => ({ label: shortAddr(a), href: `/whale?a=${a}` })),
    );
  }

  // "similar to X"
  if (tok && /similar|comparable|like this|historical/.test(q)) {
    const rep = findSimilar(store, tok.info.mint);
    if (rep && rep.samples >= 5) {
      return mk(
        `Among ${rep.samples} historically similar setups, the median 24h outcome was ${rep.median24h.toFixed(1)}% with a spread from ${rep.p10_24h.toFixed(1)}% (p10) to ${rep.p90_24h.toFixed(1)}% (p90). Distribution, not destiny.`,
        rep.matches.slice(0, 5).map((m) => ({ label: `${m.symbol} @ ${new Date(m.ts).toLocaleDateString()}`, value: `24h ${m.outcome24hPct.toFixed(1)}%` })),
        [{ label: `Open ${tok.info.symbol}`, href: `/token?m=${tok.info.mint}` }],
      );
    }
  }

  // "biggest whale exits today"
  if (/exit|sold|selling|dump/.test(q)) {
    const trades = [...store.universe.trades, ...store.liveTrades].filter(
      (t) => t.ts >= now - DAY && t.ts <= now && t.side === "sell" && (t.classification === "exit" || t.amountUsd >= 20_000),
    );
    const top = trades.sort((a, b) => b.amountUsd - a.amountUsd).slice(0, 6);
    return mk(
      top.length
        ? `The largest tracked exits in the last 24h total ${usd(top.reduce((s, t) => s + t.amountUsd, 0))} across ${new Set(top.map((t) => t.mint)).size} tokens.`
        : "No tracked wallet made a large exit in the last 24h.",
      top.map((t) => ({
        label: `${store.wallet(t.wallet)?.knownEntity ?? shortAddr(t.wallet)} → ${store.token(t.mint)?.info.symbol}`,
        value: `${usd(t.amountUsd)} (${t.classification})`,
      })),
      top.map((t) => ({ label: store.token(t.mint)?.info.symbol ?? "?", href: `/token?m=${t.mint}` })),
    );
  }

  // "smart money + liquidity rising" screens
  if (/smart money|smart-money/.test(q)) {
    const rows = buildTokenRows(store).filter((r) => r.smFlow6hUsd > 0 && r.smWallets >= 1);
    const top = rows.sort((a, b) => b.smFlow6hUsd - a.smFlow6hUsd).slice(0, 6);
    return mk(
      top.length
        ? `${rows.length} tokens have positive smart-money flow right now; the strongest is ${top[0].symbol} (${usd(top[0].smFlow6hUsd)} across ${top[0].smWallets} wallets).`
        : "No token shows positive smart-money flow in the current window.",
      top.map((r) => ({ label: r.symbol, value: `${usd(r.smFlow6hUsd)} · ${r.smWallets} wallets · liq ${r.h24 >= 0 ? "+" : ""}${r.h24.toFixed(0)}% 24h px` })),
      top.map((r) => ({ label: r.symbol, href: `/token?m=${r.mint}` })),
    );
  }

  // "what changed in the last hour"
  if (/last hour|changed|recent|right now|happening/.test(q)) {
    const events = store.recentEvents(80).filter((e) => e.ts >= now - HOUR);
    const buys = events.filter((e) => e.kind.endsWith("_buy")).length;
    const sells = events.filter((e) => e.kind.endsWith("_sell")).length;
    const sigs = events.filter((e) => e.kind === "signal_created");
    return mk(
      `In the last hour the feed recorded ${events.length} events: ${buys} tracked buys, ${sells} tracked sells, ${sigs.length} new high signals.`,
      events.slice(0, 8).map((e) => ({ label: e.headline, value: e.detail })),
      [{ label: "Open live scanner", href: "/scanner" }],
    );
  }

  // default: current top of the book
  const top = signalsAt(store, now).filter((s) => s.label !== "NO TRADE").slice(0, 5);
  return mk(
    `Right now the highest-ranked setups are ${top
      .map((s) => `${store.token(s.mint)?.info.symbol} (${s.score})`)
      .join(", ")}. Ask about a specific token ("why is ${store.token(top[0]?.mint)?.info.symbol ?? "…"} rising"), wallet activity, exits, or smart-money screens.`,
    top.map((s) => ({
      label: store.token(s.mint)?.info.symbol ?? "?",
      value: `${s.score}/100 ${s.label} — ${s.why[0] ?? ""}`,
    })),
    top.map((s) => ({ label: store.token(s.mint)?.info.symbol ?? "?", href: `/token?m=${s.mint}` })),
  );
}
