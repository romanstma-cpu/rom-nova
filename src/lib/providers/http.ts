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

export function healthOf(name: string, mode: ProviderHealth["mode"]): ProviderHealth {
  const s = state(name);
  const avgLatency = s.latencies.length ? s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length : 0;
  const errorRate = s.requests > 0 ? (s.errors / s.requests) * 100 : 0;
  return {
    name,
    mode,
    status: mode === "disabled" ? "down" : errorRate > 30 ? "down" : errorRate > 8 ? "degraded" : "ok",
    latencyMs: Math.round(avgLatency),
    errorRatePct: Number(errorRate.toFixed(1)),
    lastSuccessTs: s.lastSuccessTs,
    lastDataTs: s.lastDataTs,
  };
}
