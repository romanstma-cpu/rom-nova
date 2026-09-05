// The account store against a fake Supabase and a fake radar: the code
// flow, the session in localStorage, the refresh before expiry, the
// magic-link landing, and the radar's /me and billing routes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, headerOf, jsonOf } from "./helpers/worker-config";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
});

const RADAR = "https://radar.example";
const AUTH = "https://proj.supabase.co";
const NOW = 1_788_000_000_000;
const SESSION_KEY = "whalenova_account_v1";

const configBody = (access: string) => ({
  access,
  auth: { url: AUTH, anon_key: "anon-1" },
  billing: { enabled: access === "subscription", price: access === "subscription" ? { amount: 900, currency: "usd", interval: "month" } : null },
  app_url: "https://romapps.xyz/nova",
});

const sessionBody = (token = "access-1") => ({
  access_token: token,
  refresh_token: "refresh-1",
  expires_in: 3600,
  expires_at: NOW / 1000 + 3600,
  user: { id: "user-1", email: "reader@example.com" },
});

async function freshStore() {
  const m = await import("../src/lib/account/auth");
  m.resetAccountStore();
  return m;
}

describe("account store", () => {
  beforeEach(() => {
    store.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the radar's /config and takes its sign-in provider from it", async () => {
    const a = await freshStore();
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: configBody("account") }));
    const cfg = await a.loadHosted(RADAR, fetchImpl);
    expect(calls[0].url).toBe(`${RADAR}/config`);
    expect(cfg?.access).toBe("account");
    expect(a.accountSnapshot().provider).toEqual({ url: AUTH, anonKey: "anon-1" });
    const down = fakeFetch(() => ({ status: 503, body: {} }));
    expect(await a.loadHosted(RADAR, down.fetchImpl)).toBeNull();
    expect(a.accountSnapshot().hostedError).toMatch(/503/);
  });

  it("sends a code, then trades it for a session it keeps in this browser", async () => {
    const a = await freshStore();
    await a.loadHosted(RADAR, fakeFetch(() => ({ status: 200, body: configBody("account") })).fetchImpl);

    const otp = fakeFetch(() => ({ status: 200, body: {} }));
    expect(await a.requestCode("not-an-email", otp.fetchImpl)).toBe(false);
    expect(otp.calls).toHaveLength(0);
    expect(a.accountSnapshot().error).toMatch(/email address/);
    expect(await a.requestCode(" Reader@Example.com ", otp.fetchImpl)).toBe(true);
    expect(otp.calls[0].url).toBe(`${AUTH}/auth/v1/otp`);
    expect(headerOf(otp.calls[0], "apikey")).toBe("anon-1");
    expect(jsonOf(otp.calls[0])).toEqual({ email: "reader@example.com", create_user: true });
    expect(a.accountSnapshot()).toMatchObject({ phase: "code-sent", email: "reader@example.com", error: null });

    const verify = fakeFetch(() => ({ status: 200, body: sessionBody() }));
    expect(await a.verifyCode("12", verify.fetchImpl)).toBe(false);
    expect(verify.calls).toHaveLength(0);
    expect(await a.verifyCode("123 456", verify.fetchImpl)).toBe(true);
    expect(verify.calls[0].url).toBe(`${AUTH}/auth/v1/verify`);
    expect(jsonOf(verify.calls[0])).toEqual({ type: "email", email: "reader@example.com", token: "123456" });
    expect(a.accountSnapshot()).toMatchObject({ phase: "in", user: { id: "user-1", email: "reader@example.com" } });
    const saved = JSON.parse(store.get(SESSION_KEY) ?? "{}");
    expect(saved).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: (NOW / 1000 + 3600) * 1000, auth: { url: AUTH, anonKey: "anon-1" } });
  });

  it("asks the link to come back to this page on the web, and to nowhere inside the desktop app", async () => {
    const a = await freshStore();
    await a.loadHosted(RADAR, fakeFetch(() => ({ status: 200, body: configBody("account") })).fetchImpl);
    const web = fakeFetch(() => ({ status: 200, body: {} }));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { protocol: "https:", origin: "https://romapps.xyz", pathname: "/nova/account" } },
    });
    try {
      expect(await a.requestCode("a@b.co", web.fetchImpl)).toBe(true);
      expect(web.calls[0].url).toBe(`${AUTH}/auth/v1/otp?redirect_to=${encodeURIComponent("https://romapps.xyz/nova/account/")}`);
      a.cancelCode();
      // the desktop shell serves the app over its own scheme: no web address to land on
      (globalThis as unknown as { window: { location: Record<string, string> } }).window.location = { protocol: "app:", origin: "app://rom-nova", pathname: "/nova/account/" };
      const desktop = fakeFetch(() => ({ status: 200, body: {} }));
      expect(await a.requestCode("a@b.co", desktop.fetchImpl)).toBe(true);
      expect(desktop.calls[0].url).toBe(`${AUTH}/auth/v1/otp`);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("says why a code was refused, and rate limits in plain words", async () => {
    const a = await freshStore();
    await a.loadHosted(RADAR, fakeFetch(() => ({ status: 200, body: configBody("account") })).fetchImpl);
    const limited = fakeFetch(() => ({ status: 429, body: { msg: "rate limit" } }));
    expect(await a.requestCode("a@b.co", limited.fetchImpl)).toBe(false);
    expect(a.accountSnapshot().error).toMatch(/too many codes/);
    await a.requestCode("a@b.co", fakeFetch(() => ({ status: 200, body: {} })).fetchImpl);
    const wrong = fakeFetch(() => ({ status: 403, body: { error_code: "otp_expired", msg: "Token has expired or is invalid" } }));
    expect(await a.verifyCode("000000", wrong.fetchImpl)).toBe(false);
    // GoTrue's words are translated for the reader
    expect(a.accountSnapshot().error).toMatch(/not accepted.*fresh one/);
    // the common case on a fresh radar: the operator's mail domain is still verifying
    a.cancelCode();
    const unsent = fakeFetch(() => ({ status: 500, body: { code: 500, error_code: "unexpected_failure", msg: "Error sending magic link email" } }));
    expect(await a.requestCode("a@b.co", unsent.fetchImpl)).toBe(false);
    expect(a.accountSnapshot().error).toMatch(/email service could not send the code/);
  });

  it("restores a stored session on the first read, and refreshes it before it expires", async () => {
    store.set(
      SESSION_KEY,
      JSON.stringify({ accessToken: "old", refreshToken: "refresh-1", expiresAt: NOW + 30_000, user: { id: "user-1", email: "r@x.y" }, auth: { url: AUTH, anonKey: "anon-1" } }),
    );
    const a = await freshStore();
    expect(a.accountSnapshot()).toMatchObject({ phase: "in", user: { id: "user-1" }, provider: { url: AUTH } });

    const refresh = fakeFetch(() => ({ status: 200, body: sessionBody("new-token") }));
    // inside the refresh-ahead window: one refresh, shared by concurrent askers
    const [t1, t2] = await Promise.all([a.accessToken(refresh.fetchImpl), a.accessToken(refresh.fetchImpl)]);
    expect(t1).toBe("new-token");
    expect(t2).toBe("new-token");
    expect(refresh.calls).toHaveLength(1);
    expect(refresh.calls[0].url).toBe(`${AUTH}/auth/v1/token?grant_type=refresh_token`);
    expect(jsonOf(refresh.calls[0])).toEqual({ refresh_token: "refresh-1" });
    // now fresh: no call at all
    expect(await a.accessToken(refresh.fetchImpl)).toBe("new-token");
    expect(refresh.calls).toHaveLength(1);
  });

  it("keeps the old token while offline, and signs out when the refresh token is dead", async () => {
    store.set(
      SESSION_KEY,
      JSON.stringify({ accessToken: "old", refreshToken: "refresh-1", expiresAt: NOW + 30_000, user: { id: "user-1", email: "" }, auth: { url: AUTH, anonKey: "anon-1" } }),
    );
    const a = await freshStore();
    const offline = fakeFetch(() => new Error("offline"));
    expect(await a.accessToken(offline.fetchImpl)).toBe("old");
    const dead = fakeFetch(() => ({ status: 400, body: { error: "invalid_grant", error_description: "Invalid Refresh Token" } }));
    expect(await a.accessToken(dead.fetchImpl)).toBeNull();
    expect(a.accountSnapshot()).toMatchObject({ phase: "out", user: null });
    expect(a.accountSnapshot().error).toMatch(/session expired/);
    expect(store.has(SESSION_KEY)).toBe(false);
  });

  it("adopts a magic-link landing only after Supabase vouches for the token", async () => {
    const a = await freshStore();
    await a.loadHosted(RADAR, fakeFetch(() => ({ status: 200, body: configBody("account") })).fetchImpl);
    const user = fakeFetch((url) => (url.endsWith("/auth/v1/user") ? { status: 200, body: { id: "user-1", email: "r@x.y" } } : { status: 404, body: {} }));
    const hash = `#access_token=link-token&refresh_token=link-refresh&expires_in=3600&expires_at=${NOW / 1000 + 3600}&token_type=bearer&type=magiclink`;
    expect(await a.adoptHashSession(hash, user.fetchImpl)).toBe(true);
    expect(headerOf(user.calls[0], "authorization")).toBe("Bearer link-token");
    expect(a.accountSnapshot()).toMatchObject({ phase: "in", user: { id: "user-1", email: "r@x.y" } });
    expect(JSON.parse(store.get(SESSION_KEY) ?? "{}")).toMatchObject({ accessToken: "link-token", refreshToken: "link-refresh" });

    a.resetAccountStore();
    store.clear();
    await a.loadHosted(RADAR, fakeFetch(() => ({ status: 200, body: configBody("account") })).fetchImpl);
    expect(await a.adoptHashSession("#error=access_denied&error_description=Email+link+is+invalid+or+has+expired", user.fetchImpl)).toBe(false);
    expect(a.accountSnapshot().error).toBe("Email link is invalid or has expired");
    expect(await a.adoptHashSession("#nothing=here", user.fetchImpl)).toBe(false);
  });

  it("asks the radar who it is, starts a checkout, opens the portal, and signs out", async () => {
    store.set(
      SESSION_KEY,
      JSON.stringify({ accessToken: "tok", refreshToken: "r", expiresAt: NOW + 3_600_000, user: { id: "user-1", email: "r@x.y" }, auth: { url: AUTH, anonKey: "anon-1" } }),
    );
    const a = await freshStore();
    const radar = fakeFetch((url, init) => {
      if (url === `${RADAR}/me`) return { status: 200, body: { access: "subscription", user: { id: "user-1", email: "r@x.y" }, entitled: false, subscription: { status: "none", has_customer: false }, billing_ready: true } };
      if (url === `${RADAR}/billing/checkout` && init?.method === "POST") return { status: 200, body: { url: "https://checkout.stripe.com/c/pay/cs_1" } };
      if (url === `${RADAR}/billing/portal`) return { status: 404, body: { error: "no billing record yet — subscribe first" } };
      if (url === `${AUTH}/auth/v1/logout`) return { status: 204, body: {} };
      return { status: 404, body: {} };
    });
    const me = await a.refreshMe(RADAR, radar.fetchImpl);
    expect(headerOf(radar.calls[0], "authorization")).toBe("Bearer tok");
    expect(me).toMatchObject({ access: "subscription", entitled: false, subscription: { status: "none", has_customer: false }, billing_ready: true });
    expect(await a.startCheckout(RADAR, radar.fetchImpl)).toBe("https://checkout.stripe.com/c/pay/cs_1");
    expect(a.accountSnapshot().checkoutUrl).toBe("https://checkout.stripe.com/c/pay/cs_1");
    expect(await a.openBillingPortal(RADAR, radar.fetchImpl)).toBeNull();
    expect(a.accountSnapshot().error).toMatch(/no billing record/);
    await a.signOut(radar.fetchImpl);
    expect(a.accountSnapshot()).toMatchObject({ phase: "out", user: null, me: null, checkoutUrl: null });
    expect(store.has(SESSION_KEY)).toBe(false);
    expect(radar.calls.at(-1)?.url).toBe(`${AUTH}/auth/v1/logout`);
    expect(await a.refreshMe(RADAR, radar.fetchImpl)).toBeNull();
  });

  it("lists, mints and revokes API keys on the radar, showing a new key once", async () => {
    store.set(
      SESSION_KEY,
      JSON.stringify({ accessToken: "tok", refreshToken: "r", expiresAt: NOW + 3_600_000, user: { id: "user-1", email: "r@x.y" }, auth: { url: AUTH, anonKey: "anon-1" } }),
    );
    const a = await freshStore();
    const keys: Record<string, unknown>[] = [{ id: "11111111-1111-4111-8111-111111111111", prefix: "nova_abcdefgh…", name: "old bot", created_at: "2026-09-01T00:00:00Z", last_used_at: null }];
    const radar = fakeFetch((url, init) => {
      if (url === `${RADAR}/api/keys` && (init?.method ?? "GET") === "GET") return { status: 200, body: { keys } };
      if (url === `${RADAR}/api/keys` && init?.method === "POST") {
        const made = { id: "22222222-2222-4222-8222-222222222222", prefix: "nova_zzzzzzzz…", name: jsonOf({ url, init }).name, created_at: "2026-09-05T00:00:00Z", last_used_at: null };
        keys.push(made);
        return { status: 201, body: { ...made, key: "nova_" + "z".repeat(40) } };
      }
      if (url.startsWith(`${RADAR}/api/keys/`) && init?.method === "DELETE") return { status: 200, body: { revoked: url.split("/").pop() } };
      return { status: 404, body: { error: "not found" } };
    });
    expect(await a.loadApiKeys(RADAR, radar.fetchImpl)).toHaveLength(1);
    expect(headerOf(radar.calls[0], "authorization")).toBe("Bearer tok");
    expect(await a.mintApiKey(RADAR, " new bot ", radar.fetchImpl)).toBe("nova_" + "z".repeat(40));
    expect(jsonOf(radar.calls[1])).toEqual({ name: "new bot" });
    expect(a.accountSnapshot().newKey).toMatchObject({ key: "nova_" + "z".repeat(40), prefix: "nova_zzzzzzzz…", name: "new bot" });
    expect(a.accountSnapshot().apiKeys).toHaveLength(2);
    a.dismissNewKey();
    expect(a.accountSnapshot().newKey).toBeNull();
    expect(await a.dropApiKey(RADAR, "11111111-1111-4111-8111-111111111111", radar.fetchImpl)).toBe(true);
    expect(radar.calls.at(-1)?.url).toBe(`${RADAR}/api/keys/11111111-1111-4111-8111-111111111111`);
    expect(a.accountSnapshot().apiKeys?.map((k) => k.id)).toEqual(["22222222-2222-4222-8222-222222222222"]);
    await a.signOut(radar.fetchImpl);
    expect(a.accountSnapshot().apiKeys).toBeNull();
  });

  it("names a radar that does not recognise the session", async () => {
    store.set(
      SESSION_KEY,
      JSON.stringify({ accessToken: "tok", refreshToken: "r", expiresAt: NOW + 3_600_000, user: { id: "user-1", email: "" }, auth: { url: AUTH, anonKey: "anon-1" } }),
    );
    const a = await freshStore();
    const radar = fakeFetch(() => ({ status: 401, body: { error: "sign in to use this radar" } }));
    expect(await a.refreshMe(RADAR, radar.fetchImpl)).toBeNull();
    expect(a.accountSnapshot().meError).toMatch(/does not recognise/);
  });
});

describe("hosted helpers", () => {
  it("normalizes a /config and formats the price Stripe reported", async () => {
    const h = await import("../src/lib/account/hosted");
    const cfg = h.normHostedConfig(RADAR, configBody("subscription"));
    expect(cfg).toEqual({
      url: RADAR,
      access: "subscription",
      auth: { url: AUTH, anonKey: "anon-1" },
      billing: { enabled: true, price: { amount: 900, currency: "usd", interval: "month" } },
      api: { enabled: false, keys: false, ratePerMin: null, docs: null },
      referrals: {},
      appUrl: "https://romapps.xyz/nova",
    });
    expect(h.normHostedConfig(RADAR, null)).toEqual({
      url: RADAR,
      access: "open",
      auth: null,
      billing: { enabled: false, price: null },
      api: { enabled: false, keys: false, ratePerMin: null, docs: null },
      referrals: {},
      appUrl: null,
    });
    const withApi = h.normHostedConfig(RADAR, { access: "account", api: { enabled: true, keys: true, rate_per_min: 60, docs: "https://x/API.md" }, referrals: { gmgn: "romnova", bogus: "x" } });
    expect(withApi.api).toEqual({ enabled: true, keys: true, ratePerMin: 60, docs: "https://x/API.md" });
    expect(withApi.referrals).toEqual({ gmgn: "romnova" });
    expect(h.normHostedConfig(RADAR, { access: "nonsense", auth: { url: AUTH } }).auth).toBeNull();
    expect(h.fmtPrice({ amount: 900, currency: "usd", interval: "month" })).toBe("$9.00 / month");
    expect(h.fmtPrice({ amount: 1500, currency: "jpy", interval: "month" })).toBe("¥1,500 / month");
    expect(h.fmtPrice({ amount: null, currency: "usd", interval: "month" })).toBeNull();
    expect(h.fmtPrice(null)).toBeNull();
  });

  it("normalizes /me and refuses a subscription without a status word", async () => {
    const h = await import("../src/lib/account/hosted");
    const me = h.normHostedMe({ access: "account", user: { id: "u", email: "e" }, entitled: true, subscription: null, billing_ready: false });
    expect(me).toEqual({ access: "account", user: { id: "u", email: "e" }, entitled: true, subscription: null, billing_ready: false });
    expect(h.normHostedMe({ subscription: { current_period_end: 5 } }).subscription).toEqual({ status: "none", current_period_end: null, cancel_at_period_end: false, has_customer: false });
  });
});
