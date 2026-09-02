// Shared HTTP layer for live providers: timeout, JSON parsing, and health
// bookkeeping in one place so every adapter reports latency/error-rate the
// same way and /status has real numbers to show.

import type { ProviderHealth } from "../types";

interface HealthState {
  latencies: number[];
  errors: number;
  requests: number;
  lastSuccessTs: number;
  lastDataTs: number;
}

const health = new Map<string, HealthState>();

function state(name: string): HealthState {
  let s = health.get(name);
  if (!s) health.set(name, (s = { latencies: [], errors: 0, requests: 0, lastSuccessTs: 0, lastDataTs: 0 }));
  return s;
}

export class ProviderError extends Error {
  constructor(
    public provider: string,
    public status: number | null,
    message: string,
  ) {
    super(`[${provider}] ${message}`);
  }
}

export async function providerFetch<T>(
  provider: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const s = state(provider);
  s.requests++;
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 8_000);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const latency = Date.now() - started;
    s.latencies.push(latency);
    if (s.latencies.length > 50) s.latencies.shift();
    if (!res.ok) {
      s.errors++;
      throw new ProviderError(provider, res.status, `HTTP ${res.status} for ${new URL(url).pathname}`);
    }
    s.lastSuccessTs = Date.now();
    s.lastDataTs = Date.now();
    return (await res.json()) as T;
  } catch (err) {
    if (!(err instanceof ProviderError)) s.errors++;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ProviderError(provider, null, `timeout after ${init.timeoutMs ?? 8000}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Record one call an adapter made WITHOUT `providerFetch`.
 *
 * Three adapters could not use it: SQD streams NDJSON and reads the body
 * itself, the chain reader needs its own abort signal and must see a 429 as a
 * cooldown rather than an error, and the holdings reader keys its rows under
 * a different vendor endpoint. All three used raw `fetch`, so nothing was
 * ever written under their /status keys and the table said "not asked yet"
 * forever about providers that had just served a page. This is the same
 * bookkeeping `providerFetch` does, exposed for the adapters that have to
 * hold the request themselves.
 */
export function noteProviderCall(provider: string, ok: boolean, latencyMs: number): void {
  const s = state(provider);
  s.requests++;
  s.latencies.push(Math.max(0, Math.round(latencyMs)));
  if (s.latencies.length > 50) s.latencies.shift();
  if (ok) {
    s.lastSuccessTs = Date.now();
    s.lastDataTs = Date.now();
  } else {
    s.errors++;
  }
}

/**
 * A provider's health, or an honest admission that nothing has been asked of it.
 *
 * `requests === 0` used to produce `● ok / 0ms / 0% errors` — a clean bill of
 * health for a provider that had never been called. That is the state of EVERY
 * provider on a cold load of /status, which is the load a bookmark or a refresh
 * produces, so the page a reader opens to find out what is working answered
 * "everything" before anything had happened.
 *
 * It is the zeros bug wearing a status chip: 0ms is not a fast provider and 0%
 * is not a reliable one when the denominator is zero. Unasked is now its own
 * state, and latency and error rate go undefined so the table dashes them the
 * way it already dashes `lastDataTs`.
 */
export function healthOf(name: string, mode: ProviderHealth["mode"]): ProviderHealth {
  const s = state(name);
  const asked = s.requests > 0;
  const avgLatency = s.latencies.length ? s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length : undefined;
  const errorRate = asked ? (s.errors / s.requests) * 100 : undefined;
  return {
    name,
    mode,
    status:
      mode === "disabled"
        ? "down"
        : !asked
          ? "unknown"
          : errorRate! > 30
            ? "down"
            : errorRate! > 8
              ? "degraded"
              : "ok",
    latencyMs: avgLatency === undefined ? undefined : Math.round(avgLatency),
    errorRatePct: errorRate === undefined ? undefined : Number(errorRate.toFixed(1)),
    lastSuccessTs: s.lastSuccessTs,
    lastDataTs: s.lastDataTs,
  };
}
