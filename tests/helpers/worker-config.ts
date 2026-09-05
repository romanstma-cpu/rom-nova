// A complete worker Config for tests, so a fake never has to be cast: every
// knob the worker reads, with the defaults loadConfig() would produce, and
// the fields under test overridden per case.

import type { Config } from "../../worker/src/config.js";

export function workerConfig(over: Partial<Config> = {}): Config {
  return {
    dryRun: true,
    supabaseUrl: "https://proj.supabase.co",
    supabaseServiceKey: "",
    supabaseAnonKey: "anon-key",
    heliusApiKey: "",
    port: 0,
    access: "open",
    stripeSecretKey: "",
    stripePriceId: "",
    stripeWebhookSecret: "",
    appUrl: "https://romapps.xyz/nova",
    entitlementGraceMs: 24 * 3_600_000,
    gates: {
      whaleThresholdSol: 10,
      whaleWindowMs: 10 * 60_000,
      signalMinScore: 70,
      signalMinSettled: 3,
      signalMinBuySol: 1,
    },
    maxTracked: 200,
    heliusWalletSubs: 20,
    heliusRps: 6,
    pumpPortalUrl: "wss://pumpportal.fun/api/data",
    rpcWsUrl: "wss://solana-rpc.publicnode.com",
    ...over,
  };
}

export type SubscriptionRow = Record<string, unknown> & { user_id: string };

/** The four calls billing and the gate make of the database, over a Map. */
export function fakeDb(rows: SubscriptionRow[] = []) {
  const store = new Map<string, SubscriptionRow>(rows.map((r) => [r.user_id, r]));
  const calls = { reads: 0, writes: 0 };
  return {
    billingReady: true as boolean | null,
    store,
    calls,
    async getSubscription(id: string): Promise<SubscriptionRow | null> {
      calls.reads++;
      return store.get(id) ?? null;
    },
    async findSubscriptionByCustomer(customer: string): Promise<SubscriptionRow | null> {
      calls.reads++;
      for (const r of store.values()) if (r.stripe_customer_id === customer) return r;
      return null;
    },
    async upsertSubscription(row: SubscriptionRow): Promise<void> {
      calls.writes++;
      store.set(row.user_id, row);
    },
  };
}

export interface FakeCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * A fetch that answers from a handler and records every call. Bodies are
 * JSON unless the handler hands back a string.
 */
export function fakeFetch(handler: (url: string, init: RequestInit | undefined) => { status: number; body: unknown } | Error) {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = handler(url, init);
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** The form body of a recorded POST, decoded. */
export function formOf(call: FakeCall): URLSearchParams {
  return new URLSearchParams(String(call.init?.body ?? ""));
}

/** The JSON body of a recorded call. */
export function jsonOf(call: FakeCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body ?? "{}")) as Record<string, unknown>;
}

/** A header of a recorded call, case-insensitively. */
export function headerOf(call: FakeCall, name: string): string | undefined {
  const h = (call.init?.headers ?? {}) as Record<string, string>;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}
