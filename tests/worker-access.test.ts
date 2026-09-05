// The gate, in its three modes, against a fake verifier and a fake table:
// the status each refusal carries, the minute the entitlement is cached,
// and the forget that lets a fresh subscriber straight in.

import { describe, expect, it } from "vitest";
import { Access } from "../worker/src/access.js";
import type { AuthVerifier } from "../worker/src/auth.js";
import { fakeDb, workerConfig } from "./helpers/worker-config";

const NOW = 1_788_000_000_000;
const H = 3_600_000;

/** A verifier that knows one token, and can be told to be down. */
function fakeVerifier(opts: { down?: boolean } = {}) {
  const calls = { verify: 0 };
  const v = {
    calls,
    async verify(token: unknown) {
      calls.verify++;
      if (opts.down) throw new Error("auth unreachable");
      return token === "good" ? { id: "user-1", email: "a@b.c" } : null;
    },
    forget() {},
    status() {
      return { checks: calls.verify };
    },
  };
  return v as unknown as AuthVerifier & { calls: { verify: number } };
}

describe("Access", () => {
  it("open: everyone, no questions", async () => {
    const access = new Access(workerConfig({ access: "open" }), { verifier: null, db: fakeDb() });
    expect(await access.check("")).toEqual({ ok: true, user: null, entitled: true, subscription: null });
    expect(await access.identify("anything")).toEqual({ ok: true, user: null });
    expect(access.status()).toMatchObject({ mode: "open", allowed: 1, auth: null });
  });

  it("account: a live session is enough; no session is 401; an outage is 503", async () => {
    const verifier = fakeVerifier();
    const access = new Access(workerConfig({ access: "account" }), { verifier, db: fakeDb() });
    expect(await access.check("good")).toMatchObject({ ok: true, user: { id: "user-1" }, entitled: true });
    expect(await access.check("bad")).toEqual({ ok: false, status: 401, reason: "sign in to use this radar" });
    const down = new Access(workerConfig({ access: "account" }), { verifier: fakeVerifier({ down: true }), db: fakeDb() });
    expect(await down.check("good")).toMatchObject({ ok: false, status: 503 });
    expect(down.status().unavailable).toBe(1);
  });

  it("subscription: 402 without a paid row, in with one, 503 before the table exists", async () => {
    const db = fakeDb([{ user_id: "user-1", status: "canceled", stripe_customer_id: "cus_1" }]);
    const access = new Access(workerConfig({ access: "subscription" }), { verifier: fakeVerifier(), db, now: () => NOW });
    const refused = await access.check("good");
    expect(refused).toMatchObject({ ok: false, status: 402, subscription: { status: "canceled", has_customer: true } });
    expect(await access.check("bad")).toMatchObject({ ok: false, status: 401 });

    db.store.set("user-1", { user_id: "user-1", status: "active", stripe_customer_id: "cus_1", current_period_end: new Date(NOW + 20 * H).toISOString() });
    // still cached from the refusal a moment ago…
    expect((await access.check("good")).ok).toBe(false);
    // …until the webhook says forget
    access.forget("user-1");
    expect(await access.check("good")).toMatchObject({ ok: true, entitled: true, subscription: { status: "active" } });

    db.billingReady = false;
    expect(await access.check("good")).toMatchObject({ ok: false, status: 503 });
  });

  it("caches an entitlement for a minute and reads fresh on request", async () => {
    const db = fakeDb([{ user_id: "user-1", status: "active" }]);
    let now = NOW;
    const access = new Access(workerConfig({ access: "subscription" }), { verifier: fakeVerifier(), db, now: () => now });
    await access.check("good");
    await access.check("good");
    expect(db.calls.reads).toBe(1);
    await access.entitlement("user-1", { fresh: true });
    expect(db.calls.reads).toBe(2);
    now += 61_000;
    await access.check("good");
    expect(db.calls.reads).toBe(3);
  });

  it("account: an API key is identified as its owner, and an unknown one refused", async () => {
    const db = fakeDb();
    const { ApiKeys } = await import("../worker/src/apikeys.js");
    const apiKeys = new ApiKeys(db, { now: () => NOW });
    const minted = await apiKeys.create({ id: "user-1" }, "bot");
    const access = new Access(workerConfig({ access: "account" }), { verifier: fakeVerifier(), db, apiKeys });
    expect(await access.identify(minted.key)).toEqual({ ok: true, user: { id: "user-1", email: "", via: "key", keyId: minted.id } });
    expect(await access.check(minted.key)).toMatchObject({ ok: true, entitled: true });
    expect(await access.identify("nova_" + "x".repeat(40))).toMatchObject({ ok: false, status: 401 });
    // a key-shaped token on a radar that issues no keys falls through to the verifier
    const noKeys = new Access(workerConfig({ access: "account" }), { verifier: fakeVerifier(), db });
    expect(await noKeys.identify(minted.key)).toMatchObject({ ok: false, status: 401 });
  });

  it("subscription: a table that cannot be read is 503, not a refusal", async () => {
    const db = fakeDb();
    db.getSubscription = async () => {
      throw new Error("connection reset");
    };
    const access = new Access(workerConfig({ access: "subscription" }), { verifier: fakeVerifier(), db, now: () => NOW });
    expect(await access.check("good")).toMatchObject({ ok: false, status: 503 });
  });
});
