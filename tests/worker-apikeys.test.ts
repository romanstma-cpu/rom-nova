// API keys: the shape of a key, the hash that is all the table keeps, the
// sliding rate limit, and the desk that mints, lists, revokes and resolves.

import { describe, expect, it } from "vitest";
import { ApiKeys, generateKey, hashKey, KEY_PREFIX, looksLikeApiKey, publicKeyRow, RateLimiter } from "../worker/src/apikeys.js";
import { HttpError } from "../worker/src/http-error.js";
import { fakeDb } from "./helpers/worker-config";

const NOW = 1_788_000_000_000;

describe("keys in shape", () => {
  it("mints a prefixed, url-safe key whose hash is what the table stores", () => {
    const k = generateKey();
    expect(k.key.startsWith(KEY_PREFIX)).toBe(true);
    expect(k.key.length).toBe(KEY_PREFIX.length + 40);
    expect(looksLikeApiKey(k.key)).toBe(true);
    expect(k.hash).toBe(hashKey(k.key));
    expect(k.hash).toHaveLength(64);
    expect(k.prefix).toBe(k.key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 8));
    expect(generateKey().key).not.toBe(k.key);
  });

  it("tells a key from a session token by its shape alone", () => {
    expect(looksLikeApiKey("nova_" + "a".repeat(40))).toBe(true);
    expect(looksLikeApiKey("nova_short")).toBe(false);
    expect(looksLikeApiKey("nova_" + "a".repeat(20) + " space")).toBe(false);
    expect(looksLikeApiKey("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig")).toBe(false);
    expect(looksLikeApiKey(undefined)).toBe(false);
  });

  it("never shows the hash", () => {
    const pub = publicKeyRow({ id: "id-1", key_hash: "deadbeef", prefix: "abcdefgh", name: "bot", created_at: "2026-09-05T00:00:00Z", last_used_at: null });
    expect(pub).toEqual({ id: "id-1", prefix: "nova_abcdefgh…", name: "bot", created_at: "2026-09-05T00:00:00Z", last_used_at: null });
    expect(JSON.stringify(pub)).not.toContain("deadbeef");
  });
});

describe("RateLimiter", () => {
  it("allows the count inside a minute, refuses past it, and forgets after the window slides", () => {
    let now = NOW;
    const rl = new RateLimiter({ perMinute: 3, now: () => now });
    expect(rl.take("a")).toMatchObject({ ok: true, remaining: 2 });
    expect(rl.take("a")).toMatchObject({ ok: true, remaining: 1 });
    expect(rl.take("a")).toMatchObject({ ok: true, remaining: 0 });
    const refused = rl.take("a");
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterS).toBeGreaterThan(0);
    expect(rl.take("b").ok).toBe(true); // another subject, its own window
    now += 61_000;
    expect(rl.take("a")).toMatchObject({ ok: true, remaining: 2 });
    expect(rl.counts).toEqual({ allowed: 5, limited: 1 });
  });
});

describe("ApiKeys", () => {
  const user = { id: "user-1", email: "r@x.y" };

  it("mints a key shown once, lists it without the key, and resolves it back to its owner", async () => {
    const db = fakeDb();
    const keys = new ApiKeys(db, { now: () => NOW });
    const made = await keys.create(user, "  trading bot  ");
    expect(made.key.startsWith("nova_")).toBe(true);
    expect(made.name).toBe("trading bot");
    expect(made.prefix.startsWith("nova_")).toBe(true);
    const listed = await keys.list("user-1");
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(made.key);
    expect(await keys.list("someone-else")).toEqual([]);

    expect(await keys.resolve(made.key)).toEqual({ id: made.id, user_id: "user-1" });
    expect(await keys.resolve(made.key)).toEqual({ id: made.id, user_id: "user-1" });
    expect(db.calls.keyReads).toBe(1); // cached
    expect(await keys.resolve("nova_" + "z".repeat(40))).toBeNull();
    expect(await keys.resolve("garbage")).toBeNull();
    await Promise.resolve();
    expect(db.calls.touches).toBe(1); // last_used_at, once per minute
    expect(keys.status()).toMatchObject({ ready: true, created: 1, unknown: 1 });
  });

  it("caps keys per reader, refuses before the table exists, and revokes at once", async () => {
    const db = fakeDb();
    const keys = new ApiKeys(db, { now: () => NOW, maxPerUser: 2 });
    await keys.create(user, "a");
    const second = await keys.create(user, "b");
    await expect(keys.create(user, "c")).rejects.toMatchObject({ status: 409 });

    expect(await keys.resolve(second.key)).not.toBeNull();
    expect(await keys.revoke("user-1", second.id)).toBe(true);
    expect(await keys.resolve(second.key)).toBeNull(); // the cache forgot it too
    expect(await keys.revoke("user-1", second.id)).toBe(false);
    expect(await keys.revoke("someone-else", (await keys.list("user-1"))[0].id)).toBe(false);
    expect(await keys.list("user-1")).toHaveLength(1);

    db.apiReady = false;
    await expect(keys.create(user, "d")).rejects.toBeInstanceOf(HttpError);
    expect(await keys.list("user-1")).toEqual([]);
  });
});
