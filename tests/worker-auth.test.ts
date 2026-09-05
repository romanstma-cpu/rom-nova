// The verifier: Supabase's /auth/v1/user asked once per token per minute,
// a dead token remembered briefly, an outage never mistaken for a yes.

import { describe, expect, it } from "vitest";
import { AuthVerifier, jwtExpiryMs } from "../worker/src/auth.js";
import { fakeFetch, headerOf } from "./helpers/worker-config";

const NOW = 1_788_000_000_000;

/** An unsigned JWT-shaped token with one claim — the verifier reads only exp. */
function tokenWithExp(expS: number): string {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify({ exp: expS, sub: "u" }))}.sig`;
}

describe("jwtExpiryMs", () => {
  it("reads exp off a token and shrugs at anything else", () => {
    expect(jwtExpiryMs(tokenWithExp(1_700_000_000))).toBe(1_700_000_000_000);
    expect(jwtExpiryMs("not.a.jwt")).toBeNull();
    expect(jwtExpiryMs("")).toBeNull();
  });
});

describe("AuthVerifier", () => {
  it("asks Supabase with the api key and the bearer, then answers from cache for a minute", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { id: "user-1", email: "a@b.c" } }));
    let now = NOW;
    const v = new AuthVerifier({ supabaseUrl: "https://proj.supabase.co/", apiKey: "service-key", fetchImpl, now: () => now });
    const token = tokenWithExp(NOW / 1000 + 3600);
    expect(await v.verify(token)).toEqual({ id: "user-1", email: "a@b.c" });
    expect(calls[0].url).toBe("https://proj.supabase.co/auth/v1/user");
    expect(headerOf(calls[0], "apikey")).toBe("service-key");
    expect(headerOf(calls[0], "authorization")).toBe(`Bearer ${token}`);
    expect(await v.verify(token)).toEqual({ id: "user-1", email: "a@b.c" });
    expect(calls).toHaveLength(1);
    now += 61_000;
    await v.verify(token);
    expect(calls).toHaveLength(2);
    expect(v.status()).toMatchObject({ checks: 3, hits: 1, valid: 2 });
  });

  it("caches a yes no longer than the token itself lives", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { id: "user-1" } }));
    let now = NOW;
    const v = new AuthVerifier({ supabaseUrl: "https://proj.supabase.co", apiKey: "k", fetchImpl, now: () => now });
    const token = tokenWithExp(NOW / 1000 + 30);
    await v.verify(token);
    now += 31_000;
    await v.verify(token);
    expect(calls).toHaveLength(2);
  });

  it("answers null for a token Supabase refuses, and remembers that briefly", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 401, body: { msg: "invalid JWT" } }));
    const v = new AuthVerifier({ supabaseUrl: "https://proj.supabase.co", apiKey: "k", fetchImpl, now: () => NOW });
    expect(await v.verify("bad")).toBeNull();
    expect(await v.verify("bad")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(v.status().invalid).toBe(1);
    expect(await v.verify("")).toBeNull();
    expect(await v.verify(undefined)).toBeNull();
    expect(await v.verify("x".repeat(5_000))).toBeNull();
  });

  it("throws when Supabase cannot be asked — never a yes on a hunch", async () => {
    const down = fakeFetch(() => new Error("ECONNREFUSED"));
    const v = new AuthVerifier({ supabaseUrl: "https://proj.supabase.co", apiKey: "k", fetchImpl: down.fetchImpl });
    await expect(v.verify("tok")).rejects.toThrow(/auth unreachable/);
    const five = fakeFetch(() => ({ status: 502, body: "bad gateway" }));
    const v2 = new AuthVerifier({ supabaseUrl: "https://proj.supabase.co", apiKey: "k", fetchImpl: five.fetchImpl });
    await expect(v2.verify("tok")).rejects.toThrow(/auth 502/);
    const empty = fakeFetch(() => ({ status: 200, body: {} }));
    const v3 = new AuthVerifier({ supabaseUrl: "https://proj.supabase.co", apiKey: "k", fetchImpl: empty.fetchImpl });
    await expect(v3.verify("tok")).rejects.toThrow(/no user id/);
    expect(v3.status().errors).toBe(1);
  });

  it("forgets a token on demand", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { id: "user-1" } }));
    const v = new AuthVerifier({ supabaseUrl: "https://proj.supabase.co", apiKey: "k", fetchImpl, now: () => NOW });
    await v.verify("tok");
    v.forget("tok");
    await v.verify("tok");
    expect(calls).toHaveLength(2);
  });
});
