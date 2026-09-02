"use client";

// Browser-side API dispatcher for the static build. Pages keep calling the
// same /api/* URLs; in static mode the calls route here instead of over the
// network, hitting the identical handlers the server routes use. The world
// runs entirely in the visitor's browser — nothing is uploaded anywhere.

import { getStore, type DemoStore } from "./demo/store";
import { ensureSimulator } from "./demo/simulator";
import { subscribeLiveEvents } from "./live/bus";
import {
  ApiError,
  handleAccuracy,
  handleAlertOp,
  handleAlertsGet,
  handleBacktest,
  handleCandles,
  handleClusters,
  handleEvents,
  handleFlow,
  handleLaunches,
  handleLiveMovers,
  handleMarket,
  handleNetwork,
  handlePaperGet,
  handlePaperOrder,
  handleResearchAsk,
  handleResearchGet,
  handleResearchNote,
  handleSearch,
  handleSignalById,
  handleSignals,
  handleStatus,
  handleTokenDetail,
  handleTokens,
  handleWalletDetail,
  handleWalletProfile,
  handleWallets,
  handleWatchlistOp,
  handleWatchlists,
  type AlertOp,
  type WatchlistOp,
} from "./api/handlers";
import { getSolReference } from "./providers/reference";
import { asChartInterval } from "./providers/jupiter-chart";
import type { StrategyProfileId } from "./types";

export const IS_STATIC = process.env.NEXT_PUBLIC_STATIC === "1";

function localStore(): DemoStore {
  return ensureSimulator();
}

const num = (v: string | null): number | undefined => {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export interface LocalResponse {
  status: number;
  body: unknown;
}

/**
 * How much of an unrouteable path this dispatcher is willing to repeat back.
 *
 * `?m=<script>alert(1)</script>` on the token page becomes a request for
 * `/api/tokens/<script>alert(1)</script>`, which matches nothing (the segment
 * pattern is `[^/]+` and that string carries a slash) and fell through to a 404
 * whose body was the raw path. The page prints the handler's message verbatim,
 * so attacker-supplied text rendered on screen.
 *
 * React escapes it, so this was never XSS. But a terminal that will print
 * whatever a link puts in its query string is a phishing surface.
 *
 * The rule: echo the leading segments, and STOP at the first one that is not
 * already a plain route name. A route here is identified by its leading
 * segments — `/api/tokens`, `/api/wallets/movers` — so that prefix is the whole
 * diagnostic value; a segment that would have to be sanitised before printing
 * is caller content, and the caller does not get to put content on the page.
 *
 * Sanitising WITHOUT truncating was tried first and was not enough: it turned
 * the payload into `/api/tokens/3Cscript3Ealert13C/script3E`, which carries no
 * markup and is still the attacker's string on the reader's screen.
 */
const ECHO_SEGMENTS = 3;
const ECHO_MAX = 48;
/** What a route segment looks like when nobody has been creative with it. */
const PLAIN_SEGMENT = /^[A-Za-z0-9_.:-]+$/;

export function safePath(p: string): string {
  const kept: string[] = [];
  for (const seg of p.split("/").filter(Boolean).slice(0, ECHO_SEGMENTS)) {
    if (!PLAIN_SEGMENT.test(seg)) break;
    kept.push(seg);
  }
  const out = `/${kept.join("/")}`;
  return out.length > ECHO_MAX ? `${out.slice(0, ECHO_MAX)}...` : out;
}

export async function localGet(url: string): Promise<LocalResponse> {
  const u = new URL(url, "http://local");
  const p = u.pathname;
  const q = u.searchParams;
  const store = localStore();

  try {
    if (p === "/api/market") {
      const reference = await getSolReference().catch(() => null);
      return { status: 200, body: { ...handleMarket(store), reference } };
    }
    if (p === "/api/tokens")
      return {
        status: 200,
        body: await handleTokens(store, {
          profile: (q.get("profile") ?? undefined) as StrategyProfileId | undefined,
          asOf: num(q.get("asOf")),
          sort: q.get("sort") ?? undefined,
          dir: (q.get("dir") ?? undefined) as "asc" | "desc" | undefined,
          limit: num(q.get("limit")),
        }),
      };
    {
      const m = p.match(/^\/api\/tokens\/([^/]+)\/candles$/);
      // Awaited: candles now go through the provider seam, so in the static
      // build this is a real fetch from the visitor's own browser rather than a
      // synchronous read of the simulator.
      if (m)
        return {
          status: 200,
          body: await handleCandles(
            store,
            m[1],
            num(q.get("from")),
            num(q.get("to")),
            asChartInterval(q.get("interval")),
          ),
        };
    }
    {
      const m = p.match(/^\/api\/tokens\/([^/]+)$/);
      // Awaited for the same reason candles are: the detail path consults live
      // providers now, so in the static build this is real network work done
      // from the visitor's own browser.
      // The mint's SHAPE is checked inside the handler rather than here, so the
      // server route gets the same guard from the same line.
      if (m)
        return {
          status: 200,
          body: await handleTokenDetail(store, m[1], num(q.get("asOf")), (q.get("profile") ?? "balanced") as StrategyProfileId),
        };
    }
    // Awaited, like candles: in the static build this is a real fetch from the
    // visitor's own browser. The feed's rolling state lives in this module for
    // the life of the tab, which is exactly what makes first-seen timestamps —
    // and therefore the measured lag — meaningful.
    if (p === "/api/launches") return { status: 200, body: await handleLaunches() };
    if (p === "/api/wallets") return { status: 200, body: handleWallets(store) };
    // Before the /:address route, which would otherwise match "movers".
    if (p === "/api/wallets/movers") return { status: 200, body: await handleLiveMovers(num(q.get("limit")) ?? 25) };
    {
      // Ordered before the bare-address route on purpose: `[^/]+` would
      // otherwise swallow "<address>/profile" and hand the simulator an
      // address it has never heard of.
      const m = p.match(/^\/api\/wallets\/([^/]+)\/profile$/);
      // Awaited: in the static build this is the visitor's own browser reading
      // Solana directly. Nothing is uploaded and no server is involved.
      if (m) {
        const stage = q.get("stage") === "balances" ? "balances" : "full";
        return { status: 200, body: await handleWalletProfile(m[1], stage) };
      }
    }
    {
      const m = p.match(/^\/api\/wallets\/([^/]+)$/);
      if (m) return { status: 200, body: handleWalletDetail(store, m[1]) };
    }
    if (p === "/api/signals")
      return {
        status: 200,
        body: handleSignals(store, (q.get("profile") ?? "balanced") as StrategyProfileId, num(q.get("asOf"))),
      };
    {
      const m = p.match(/^\/api\/signals\/([^/]+)$/);
      if (m) return { status: 200, body: handleSignalById(store, m[1]) };
    }
    if (p === "/api/accuracy")
      return { status: 200, body: handleAccuracy(store, (q.get("profile") ?? "balanced") as StrategyProfileId) };
    if (p === "/api/network") return { status: 200, body: handleNetwork(store, num(q.get("asOf"))) };
    if (p === "/api/events") return { status: 200, body: handleEvents(store, num(q.get("limit")) ?? 60) };
    if (p === "/api/status") return { status: 200, body: handleStatus(store) };
    if (p === "/api/flow") return { status: 200, body: handleFlow(store, q.get("mint"), num(q.get("hours")) ?? 72) };
    if (p === "/api/clusters") return { status: 200, body: handleClusters(store) };
    if (p === "/api/search") return { status: 200, body: handleSearch(store, q.get("q") ?? "") };
    if (p === "/api/watchlists") return { status: 200, body: handleWatchlists(store) };
    if (p === "/api/alerts") return { status: 200, body: handleAlertsGet(store) };
    if (p === "/api/paper") return { status: 200, body: handlePaperGet(store) };
    if (p === "/api/research") return { status: 200, body: handleResearchGet(store) };
    return { status: 404, body: { error: `no local route for ${safePath(p)}` } };
  } catch (err) {
    if (err instanceof ApiError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
}

export async function localPost(url: string, body: unknown): Promise<LocalResponse> {
  const u = new URL(url, "http://local");
  const p = u.pathname;
  const store = localStore();
  const b = (body ?? {}) as Record<string, unknown>;

  try {
    if (p === "/api/backtests") return { status: 200, body: handleBacktest(store, b) };
    if (p === "/api/watchlists") return { status: 200, body: handleWatchlistOp(store, b as unknown as WatchlistOp) };
    if (p === "/api/alerts") return { status: 200, body: handleAlertOp(store, b as unknown as AlertOp) };
    if (p === "/api/paper/orders") {
      const res = handlePaperOrder(store, {
        portfolioId: String(b.portfolioId ?? ""),
        mint: String(b.mint ?? ""),
        side: b.side === "sell" ? "sell" : "buy",
        usd: Number(b.usd) || 0,
        stopLossPct: b.stopLossPct !== undefined ? Number(b.stopLossPct) : undefined,
        takeProfitPct: b.takeProfitPct !== undefined ? Number(b.takeProfitPct) : undefined,
      });
      return { status: res.status, body: res.body };
    }
    if (p === "/api/research") return { status: 200, body: handleResearchNote(store, String(b.mint ?? ""), String(b.note ?? "")) };
    if (p === "/api/research/ask") return { status: 200, body: handleResearchAsk(store, String(b.question ?? "")) };
    return { status: 404, body: { error: `no local route for ${safePath(p)}` } };
  } catch (err) {
    if (err instanceof ApiError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
}

/**
 * Static-mode event subscription — same shape the SSE stream delivers.
 *
 * Two sources fan into one subscription: the demo store's synthetic events,
 * marked `real: false` so every renderer can label them without knowing where
 * they came from, and the live bus, which is where sockets and the live
 * signal path publish. Before the bus existed this forwarded the simulator
 * alone, and the shipped app's every toast was fiction wearing a live pulse.
 */
export function localSubscribe(onEvent: (e: unknown) => void): () => void {
  const store = localStore();
  const offDemo = store.onEvent((e) =>
    onEvent({ ...e, real: false, source: "demo", symbol: e.mint ? getStore().token(e.mint)?.info.symbol : undefined }),
  );
  const offLive = subscribeLiveEvents((e) => onEvent(e));
  return () => {
    offDemo();
    offLive();
  };
}
