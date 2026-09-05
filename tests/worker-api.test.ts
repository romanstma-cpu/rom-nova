// The HTTP API, driven directly: an open radar's routes, the limits, the
// history read, and a gated radar's keys — minted by a session, refused to
// a key, judged as their owner.

import { describe, expect, it } from "vitest";
import { Access } from "../worker/src/access.js";
import { Api, parseLimit, parseSince } from "../worker/src/api.js";
import { ApiKeys, RateLimiter } from "../worker/src/apikeys.js";
import type { AuthVerifier } from "../worker/src/auth.js";
import { fakeDb, workerConfig } from "./helpers/worker-config";

const NOW = 1_788_000_000_000;
const ADDR = "So11111111111111111111111111111111111111112";

function rings() {
  const signals = Array.from({ length: 5 }, (_, i) => ({ signal_key: `s${i}`, wallet_address: i % 2 ? ADDR : "OTHER", token_address: `M${i}`, timestamp: new Date(NOW - (5 - i) * 60_000).toISOString() }));
  return { signals, launches: [{ mint: "L1" }, { mint: "L2" }], whales: [{ wallet: "W" }], trades: [{ signature: "t" }], behaviours: [] };
}

function fakeVerifier() {
  return {
    async verify(token: unknown) {
      return token === "session-good" ? { id: "user-1", email: "r@x.y" } : null;
    },
    forget() {},
    status() {
      return {};
    },
  } as unknown as AuthVerifier;
}

function build(mode: "open" | "account" | "subscription", opts: { perMinute?: number; signals?: Record<string, unknown>[] } = {}) {
  const cfg = workerConfig({ access: mode, apiRatePerMinute: opts.perMinute ?? 60 });
  const db = fakeDb(mode === "subscription" ? [{ user_id: "user-1", status: "active" }] : [], { signals: opts.signals });
  const apiKeys = new ApiKeys(db, { now: () => NOW });
  const access = new Access(cfg, { verifier: mode === "open" ? null : fakeVerifier(), db, apiKeys, now: () => NOW });
  const limiter = new RateLimiter({ perMinute: cfg.apiRatePerMinute, now: () => NOW });
  const data = { rings, topWallets: (n: number) => [{ wallet_address: ADDR, score: 80 }, { wallet_address: "OTHER", score: 70 }].slice(0, n), wallet: (a: string) => (a === ADDR ? { wallet_address: ADDR, score: 80 } : null) };
  const api = new Api({ cfg, access, apiKeys, limiter, db, data, now: () => NOW });
  return { api, db, apiKeys };
}

describe("parsing", () => {
  it("clamps limits and bounds since to the served history", () => {
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit("10")).toBe(10);
    expect(parseLimit("999")).toBe(200);
    expect(parseLimit("-3")).toBe(50);
    expect(parseLimit("abc")).toBe(50);
    expect(parseSince(undefined, NOW)).toBeNull();
    expect(parseSince("2026-09-05T00:00:00Z", NOW)).toBe("2026-09-05T00:00:00.000Z");
    expect(parseSince("2020-01-01T00:00:00Z", NOW)).toBe(new Date(NOW - 30 * 86_400_000).toISOString());
    expect(() => parseSince("yesterday", NOW)).toThrow(/ISO-8601/);
  });
});

describe("an open radar", () => {
  it("serves every plane with no token, newest first, with the rate headers", async () => {
    const { api } = build("open");
    const sig = await api.handle("GET", "/api/v1/signals", { limit: "2" }, "", { remote: "1.2.3.4" });
    expect(sig.status).toBe(200);
    expect(sig.body.signals.map((s: { signal_key: string }) => s.signal_key)).toEqual(["s4", "s3"]);
    expect(sig.body.since).toBeNull();
    expect(sig.headers).toMatchObject({ "x-ratelimit-limit": "60", "x-ratelimit-remaining": "59" });
    expect(typeof sig.body.as_of).toBe("string");

    expect((await api.handle("GET", "/api/v1/wallets", { limit: "1" }, "")).body.wallets).toEqual([{ wallet_address: ADDR, score: 80 }]);
    const one = await api.handle("GET", `/api/v1/wallets/${ADDR}`, {}, "");
    expect(one.body.wallet.score).toBe(80);
    expect(one.body.signals.every((s: { wallet_address: string }) => s.wallet_address === ADDR)).toBe(true);
    expect((await api.handle("GET", "/api/v1/wallets/OTHER", {}, "")).status).toBe(400);
    expect((await api.handle("GET", `/api/v1/wallets/${"1".repeat(40)}`, {}, "")).status).toBe(404);
    expect((await api.handle("GET", "/api/v1/launches", {}, "")).body.launches).toEqual([{ mint: "L2" }, { mint: "L1" }]);
    expect((await api.handle("GET", "/api/v1/behaviours", {}, "")).body.behaviours).toEqual([]);
    expect((await api.handle("GET", "/api/v1/nothing", {}, "")).status).toBe(404);
    expect((await api.handle("POST", "/api/v1/signals", {}, "")).status).toBe(405);
    expect((await api.handle("GET", "/api/keys", {}, "")).status).toBe(404);
  });

  it("reads history from the database when asked since an instant", async () => {
    const signals = [
      { signal_key: "old", timestamp: new Date(NOW - 3 * 86_400_000).toISOString() },
      { signal_key: "new", timestamp: new Date(NOW - 3_600_000).toISOString() },
    ];
    const { api } = build("open", { signals });
    const r = await api.handle("GET", "/api/v1/signals", { since: new Date(NOW - 86_400_000).toISOString() }, "");
    expect(r.body.signals.map((s: { signal_key: string }) => s.signal_key)).toEqual(["new"]);
    expect((await api.handle("GET", "/api/v1/signals", { since: "nope" }, "")).status).toBe(400);
  });

  it("limits by caller and says when to come back", async () => {
    const { api } = build("open", { perMinute: 2 });
    await api.handle("GET", "/api/v1/launches", {}, "", { remote: "a" });
    await api.handle("GET", "/api/v1/launches", {}, "", { remote: "a" });
    const refused = await api.handle("GET", "/api/v1/launches", {}, "", { remote: "a" });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers?.["retry-after"])).toBeGreaterThan(0);
    expect((await api.handle("GET", "/api/v1/launches", {}, "", { remote: "b" })).status).toBe(200);
    expect(api.status()).toMatchObject({ requests: 4, limited: 1, served: 3, rate_per_min: 2 });
  });
});

describe("a gated radar", () => {
  it("refuses the data without a session or key, and admits a key as its owner", async () => {
    const { api, apiKeys } = build("account");
    expect((await api.handle("GET", "/api/v1/signals", {}, "")).status).toBe(401);
    expect((await api.handle("GET", "/api/v1/signals", {}, "session-good")).status).toBe(200);

    const minted = await api.handle("POST", "/api/keys", {}, "session-good", { body: { name: "bot" } });
    expect(minted.status).toBe(201);
    const key: string = minted.body.key;
    expect(key.startsWith("nova_")).toBe(true);
    expect((await api.handle("GET", "/api/v1/signals", {}, key)).status).toBe(200);
    expect((await api.handle("GET", "/api/v1/signals", {}, "nova_" + "q".repeat(40))).status).toBe(401);

    // keys are managed by sessions only
    expect((await api.handle("POST", "/api/keys", {}, key, { body: {} })).status).toBe(403);
    expect((await api.handle("GET", "/api/keys", {}, "bad-session")).status).toBe(401);
    const list = await api.handle("GET", "/api/keys", {}, "session-good");
    expect(list.body.keys).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(key);

    expect((await api.handle("DELETE", `/api/keys/${minted.body.id}`, {}, "session-good")).status).toBe(200);
    expect((await api.handle("DELETE", `/api/keys/${minted.body.id}`, {}, "session-good")).status).toBe(404);
    expect((await api.handle("GET", "/api/v1/signals", {}, key)).status).toBe(401);
    expect(apiKeys.status().revoked).toBe(1);
  });

  it("judges a key by its owner's plan", async () => {
    const { api, db } = build("subscription");
    const minted = await api.handle("POST", "/api/keys", {}, "session-good", { body: { name: "bot" } });
    const key: string = minted.body.key;
    expect((await api.handle("GET", "/api/v1/wallets", {}, key)).status).toBe(200);
    db.store.set("user-1", { user_id: "user-1", status: "canceled" });
    // the entitlement is cached a minute; a fresh Access reads the row
    const { api: later } = build("subscription");
    later.apiKeys.db = db;
    later.access.db = db;
    later.access.apiKeys = later.apiKeys;
    expect((await later.handle("GET", "/api/v1/wallets", {}, key)).status).toBe(402);
  });
});
