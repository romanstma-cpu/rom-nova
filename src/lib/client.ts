"use client";

// Client-side data layer: fetch hook, POST helper, event subscription,
// formatting. In the static build (NEXT_PUBLIC_STATIC=1) every call routes
// to the in-browser engine instead of the network — same URLs, same
// handlers, zero server.

import { useCallback, useEffect, useRef, useState } from "react";
import { IS_STATIC, localGet, localPost, localSubscribe } from "./local";
import { WHALE_TRADE_USD } from "./engine/thresholds";

export async function apiGet<T = unknown>(url: string): Promise<T> {
  return (await getJson(url)) as T;
}

async function getJson(url: string): Promise<unknown> {
  if (IS_STATIC) {
    const res = await localGet(url);
    if (res.status >= 400) throw new Error((res.body as { error?: string })?.error ?? `error ${res.status}`);
    return res.body;
  }
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** POST that works identically in server and static modes. */
export async function apiPost<T = Record<string, unknown>>(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; body: T }> {
  if (IS_STATIC) {
    const res = await localPost(url, body);
    return { ok: res.status < 400, status: res.status, body: res.body as T };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, body: json };
}

export function useApi<T>(url: string | null, refreshMs?: number): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!url) return;
    let dead = false;
    const run = async () => {
      try {
        const json = (await getJson(url)) as T;
        if (!dead) {
          setData(json);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!dead) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    };
    run();

    // Poll only while the tab is actually being looked at.
    //
    // This used to be an unconditional setInterval, which in the static build
    // is worse than it sounds: every tick runs the full handler — rebuilding
    // signals, walking the universe — inside the visitor's browser. A Nova tab
    // left open in the background re-derived the whole world every 8 to 30
    // seconds, forever, on someone's battery. For an app whose entire pitch is
    // "runs in your tab", that is the one bug it cannot afford.
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (!refreshMs || timer !== undefined) return;
      timer = setInterval(run, refreshMs);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Refresh on the way back in, so the first thing seen is not whatever
        // was on screen when the tab was hidden.
        void run();
        start();
      } else {
        stop();
      }
    };

    if (typeof document === "undefined" || document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      dead = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [url, refreshMs, nonce]);

  return { data, error, loading, reload };
}

export interface StreamEvent {
  id: string;
  kind: string;
  ts: number;
  mint?: string;
  wallet?: string;
  amountUsd?: number;
  headline: string;
  detail: string;
  confidence?: number;
  symbol?: string;
  /**
   * True only when a real source produced this event. Absent or false is the
   * simulator, and every surface that renders a stream event labels it from
   * THIS field — the toasts and the activity feed used to render the same
   * payload as SIMULATED on one and "streaming" on the other.
   */
  real?: boolean;
  /** The adapter or socket that produced it — "demo", "pumpportal-ws", "solana-rpc-ws"… */
  source?: string;
}

/** Subscribe to the live event feed — SSE in server mode, the in-browser
 * simulator in static mode. Reconnects on drop. */
export function useEventStream(onEvent: (e: StreamEvent) => void, enabled = true) {
  const cb = useRef(onEvent);
  useEffect(() => {
    cb.current = onEvent;
  });
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    if (IS_STATIC) {
      // in-browser bus: connection is a given, no state churn needed
      const unsub = localSubscribe((e) => cb.current(e as StreamEvent));
      return () => unsub();
    }
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let dead = false;
    const connect = () => {
      if (dead) return;
      es = new EventSource("/api/stream");
      es.onopen = () => setConnected(true);
      es.onmessage = (m) => {
        try {
          const data = JSON.parse(m.data);
          if (data.headline) cb.current(data as StreamEvent);
        } catch {
          /* heartbeat / hello */
        }
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      dead = true;
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, [enabled]);

  return IS_STATIC ? enabled : connected;
}

// ---------------------------------------------------------------- format

export const fmtUsd = (x: number | undefined | null, digits?: number): string => {
  if (x === undefined || x === null || Number.isNaN(x)) return "—";
  const abs = Math.abs(x);
  const sign = x < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(digits ?? 2)}`;
  if (abs === 0) return "$0";
  // sub-dollar meme prices: keep 4 significant digits
  const exp = Math.floor(Math.log10(abs));
  return `${sign}$${abs.toFixed(Math.min(12, 3 - exp))}`;
};

export const fmtPct = (x: number | undefined | null, digits = 1): string => {
  if (x === undefined || x === null || Number.isNaN(x)) return "—";
  return `${x >= 0 ? "+" : ""}${x.toFixed(digits)}%`;
};

export const fmtNum = (x: number | undefined | null): string => {
  if (x === undefined || x === null || Number.isNaN(x)) return "—";
  const abs = Math.abs(x);
  if (abs >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(x / 1e3).toFixed(1)}K`;
  return String(Math.round(x));
};

export const fmtAge = (ms: number): string => {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
};

export const fmtAgo = (ts: number, now = Date.now()): string => {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export const shortAddr = (a: string): string => (a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);

export const scoreColor = (score: number): string =>
  score >= 76 ? "var(--pos)" : score >= 60 ? "var(--accent)" : score >= 45 ? "var(--text-dim)" : "var(--neg)";

/**
 * How a whale-netflow cell should be coloured, and what its tooltip must say.
 *
 * Two corrections in one place, because they are one mistake.
 *
 * COLOUR. `usd >= 0 ? "pos" : "neg"` painted a measured ZERO green. Production
 * showed $0 on eleven of twelve scanner rows, all green, reading as "no whale
 * sold this" when the truth was "nobody moved $20,000 in the window". Zero is
 * the absence of the thing the column measures, so it is neutral.
 *
 * WINDOW. The column said "Whale 6h" and the window is a ten-minute chain scan,
 * truncated further whenever the byte budget bites — which is why the tooltip
 * takes the row's OWN `flowMinutes` rather than a constant. The token page has
 * always told the truth about this ("the flow window is ten minutes, not the
 * life of the chart"); the list contradicted it.
 */
export const whaleFlowCell = (
  r: { whaleFlowUsd: number; flowMinutes?: number; unmeasured?: readonly string[] },
  threshold = WHALE_TRADE_USD,
): { cls: string; title: string; text: string } => {
  const usd = r.whaleFlowUsd;
  const window =
    r.flowMinutes === undefined
      ? "a short chain scan"
      : `the last ${r.flowMinutes < 1 ? "<1" : Math.round(r.flowMinutes)} min of chain`;
  // ABSENCE FIRST. The engine never produces a measured whale-flow zero on
  // the live path: a window with movement but no $20,000+ move, a provider
  // that answered with nothing, and no provider at all ALL declare the field
  // unmeasured. Three pages ignored that declaration and printed the
  // placeholder `$0` under a tooltip calling it "a quiet window", ~3 seconds
  // after the scanner had rendered the identical rows as "—". Eleven of twelve
  // rows on the screener. The scanner also gave a single false reason for the
  // dash ("no wallet-flow source configured") when the source was configured,
  // live, and answering for other rows in the same batch — so the reason names
  // every cause honestly rather than picking one.
  if (absent(r, "whaleFlow")) {
    return {
      cls: "faint",
      text: "—",
      title:
        `no whale reading for this row: either ${window} held no single $${threshold.toLocaleString()}+ move, ` +
        "or the flow read returned nothing (rate limit or byte budget), or no flow source answered. " +
        "An absence is not a quiet verdict — the token page names which of these it was.",
    };
  }
  return {
    cls: usd > 0 ? "pos" : usd < 0 ? "neg" : "dim",
    text: fmtUsd(usd),
    title:
      usd === 0
        ? `no single wallet moved $${threshold.toLocaleString()}+ of this token in ${window}. That is a quiet window, not a verdict — and it is NOT six hours.`
        : `net whale movement over ${window}, counting only wallets that moved $${threshold.toLocaleString()}+`,
  };
};

/**
 * Whether a field was declared unmeasured for this row.
 *
 * Shared, because the scanner had it and three other pages did not — and the
 * pages without it printed placeholder zeros as readings. Any surface that
 * renders a `TokenRow` number consults this before formatting it.
 */
export const absent = (r: { unmeasured?: readonly string[] }, field: string): boolean =>
  (r.unmeasured ?? []).includes(field);

export const labelClass = (label: string): string => {
  if (label.includes("POSITIVE")) return "chip-pos";
  if (label === "NO TRADE" || label === "NEUTRAL" || label === "WATCH") return "chip";
  if (label.includes("RISK") || label === "NEGATIVE" || label === "WEAK") return "chip-neg";
  return "chip";
};
