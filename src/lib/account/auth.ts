"use client";

// The reader's account — for the hosted radar, and for nothing else.
//
// Nova needs no account. Every page runs keyless in the browser and keeps
// its state there. The one thing an account buys is a Radar worker that
// asks for one: ROM's hosted radar runs 24/7 on a server, and a server
// that never sleeps costs money, so its feed sits behind a sign-in and,
// when the operator turns it on, a subscription. This module is that
// sign-in: an email, a six-digit code from Supabase Auth, a session kept
// in this browser, and the token the radar client hands over when it
// connects. No password exists anywhere in this flow.
//
// Where sign-in goes is not baked in. The radar says, over /config, which
// Supabase project signs its readers in; this store remembers that
// alongside the session, so a token can be refreshed on the next visit
// before the radar has been asked anything.
//
// Talks to Supabase's GoTrue REST endpoints directly — four of them —
// rather than carrying supabase-js into a bundle that otherwise has no
// use for it. Every call takes a fetch so the tests can play Supabase.

import {
  createApiKey,
  fetchApiKeys,
  fetchCheckoutUrl,
  fetchHostedConfig,
  fetchMe,
  fetchPortalUrl,
  HostedError,
  revokeApiKey,
  type ApiKeyRow,
  type HostedConfig,
  type HostedMe,
} from "./hosted";

const SESSION_KEY = "whalenova_account_v1";
/** Refresh this long before the access token expires, so a live socket never carries a dead one. */
const REFRESH_AHEAD_MS = 60_000;
const CODE_RE = /^\d{6,8}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthProvider {
  url: string;
  anonKey: string;
}

export interface AccountUser {
  id: string;
  email: string;
}

export interface AccountSession {
  accessToken: string;
  refreshToken: string;
  /** ms since epoch */
  expiresAt: number;
  user: AccountUser;
  auth: AuthProvider;
}

export interface AccountState {
  phase: "out" | "code-sent" | "in";
  /** the address a code went to, or the signed-in address */
  email: string;
  user: AccountUser | null;
  /** where sign-in goes — from the radar's /config, or the stored session */
  provider: AuthProvider | null;
  busy: boolean;
  error: string | null;
  /** the radar's /config, last read */
  hosted: HostedConfig | null;
  hostedError: string | null;
  /** the radar's /me for this session, last read */
  me: HostedMe | null;
  meError: string | null;
  /** a minted Checkout URL, kept so the page can offer a link if the popup was blocked */
  checkoutUrl: string | null;
  /** the reader's API keys on the radar, last read — null until asked */
  apiKeys: ApiKeyRow[] | null;
  /** a key just minted, in the clear, until the reader dismisses it */
  newKey: { key: string; prefix: string; name: string } | null;
  keysError: string | null;
  asOf: number;
}

const SERVER_STATE: AccountState = {
  phase: "out",
  email: "",
  user: null,
  provider: null,
  busy: false,
  error: null,
  hosted: null,
  hostedError: null,
  me: null,
  meError: null,
  checkoutUrl: null,
  apiKeys: null,
  newKey: null,
  keysError: null,
  asOf: 0,
};

let state: AccountState = SERVER_STATE;
let restored = false;
const listeners = new Set<() => void>();
let refreshing: Promise<string | null> | null = null;

function notify(next: Partial<AccountState>): void {
  state = { ...state, ...next, asOf: Date.now() };
  for (const l of listeners) l();
}

// ------------------------------------------------------------ the session

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function readSession(): AccountSession | null {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Record<string, unknown>;
    const u = (o.user ?? {}) as Record<string, unknown>;
    const a = (o.auth ?? {}) as Record<string, unknown>;
    if (!str(o.accessToken) || !str(o.refreshToken) || !str(u.id) || !str(a.url) || !str(a.anonKey)) return null;
    return {
      accessToken: str(o.accessToken),
      refreshToken: str(o.refreshToken),
      expiresAt: typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt) ? o.expiresAt : 0,
      user: { id: str(u.id), email: str(u.email) },
      auth: { url: str(a.url), anonKey: str(a.anonKey) },
    };
  } catch {
    return null;
  }
}

function writeSession(s: AccountSession | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private window or quota: signed in for this page load only */
  }
}

/** The stored session into state, once, on the first client read. */
function ensureRestored(): void {
  if (restored || typeof localStorage === "undefined") return;
  restored = true;
  const s = readSession();
  if (s) state = { ...state, phase: "in", user: s.user, email: s.user.email, provider: s.auth };
}

export function subscribeAccount(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function accountSnapshot(): AccountState {
  ensureRestored();
  return state;
}

export const accountServerSnapshot = (): AccountState => SERVER_STATE;

/** Tests only: forget everything this module cached. */
export function resetAccountStore(): void {
  state = SERVER_STATE;
  restored = false;
  refreshing = null;
}

// -------------------------------------------------------------- GoTrue

type Fetch = typeof fetch;

interface GoTrueReply {
  ok: boolean;
  status: number;
  body: unknown;
}

async function gotrue(p: AuthProvider, path: string, init: { method?: string; body?: unknown; token?: string }, fetchImpl: Fetch): Promise<GoTrueReply> {
  const headers: Record<string, string> = { apikey: p.anonKey, "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetchImpl(`${p.url}/auth/v1${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body: unknown = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

/** GoTrue's error line, whichever of its shapes it came in. */
function messageOf(body: unknown, fallback: string): string {
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  for (const k of ["error_description", "msg", "message", "error"]) {
    const v = o?.[k];
    if (typeof v === "string" && v) return v;
  }
  return fallback;
}

/**
 * GoTrue's words are for the operator; these are for the reader. The
 * first one is the common case on a fresh radar: the operator's mail
 * domain is still verifying, and every code fails to send until it is.
 */
const FRIENDLY_AUTH: [RegExp, string][] = [
  [/error sending .*email|smtp|mailer/i, "the radar's email service could not send the code — if the operator's mail domain is still being verified, try again in a few minutes"],
  [/rate limit|too many/i, "too many codes requested — wait a minute and try again"],
  [/signups? not allowed|disabled/i, "this radar is not accepting new sign-ins"],
  [/expired|invalid/i, "that code was not accepted — codes expire after an hour; request a fresh one"],
];
export function friendlyAuthError(raw: string): string {
  for (const [re, text] of FRIENDLY_AUTH) if (re.test(raw)) return text;
  return raw;
}

/** A session out of a token response — /verify and /token answer in the same shape. */
function sessionOf(p: AuthProvider, body: unknown): AccountSession | null {
  const o = (body ?? {}) as Record<string, unknown>;
  const u = (o.user ?? {}) as Record<string, unknown>;
  if (!str(o.access_token) || !str(o.refresh_token) || !str(u.id)) return null;
  const expiresAt =
    typeof o.expires_at === "number" && Number.isFinite(o.expires_at)
      ? o.expires_at * 1000
      : Date.now() + (typeof o.expires_in === "number" && Number.isFinite(o.expires_in) ? o.expires_in : 3600) * 1000;
  return {
    accessToken: str(o.access_token),
    refreshToken: str(o.refresh_token),
    expiresAt,
    user: { id: str(u.id), email: str(u.email) },
    auth: p,
  };
}

// --------------------------------------------------------------- actions

/** The radar's /config: its gate, and where its sign-in goes. */
export async function loadHosted(url: string, fetchImpl: Fetch = fetch): Promise<HostedConfig | null> {
  ensureRestored();
  try {
    const cfg = await fetchHostedConfig(url, fetchImpl);
    notify({ hosted: cfg, hostedError: null, provider: cfg.auth ?? state.provider });
    return cfg;
  } catch (err) {
    // A worker from before 1.21.0 has no /config and no CORS on its 404,
    // which a browser reports as a bare "Failed to fetch".
    notify({
      hosted: null,
      hostedError: err instanceof HostedError ? err.message : "no answer from /config — an older worker, or unreachable",
    });
    return null;
  }
}

/**
 * Where a magic link should land: this very page, on the web, so the
 * fragment it carries is adopted by the code that knows how. Inside the
 * desktop app there is no web address to land on — the link opens the
 * system browser and signs the WEB app in — so the desktop relies on the
 * code, and the operator's email template must carry {{ .Token }}.
 */
function redirectTarget(): string | null {
  if (typeof window === "undefined" || !window.location) return null;
  const { protocol, origin, pathname } = window.location;
  if (protocol !== "https:" && protocol !== "http:") return null;
  return `${origin}${pathname.endsWith("/") ? pathname : `${pathname}/`}`;
}

/** Step one: an email, and Supabase sends it a code (and a link that lands back here). */
export async function requestCode(email: string, fetchImpl: Fetch = fetch): Promise<boolean> {
  ensureRestored();
  const p = state.provider;
  const addr = email.trim().toLowerCase();
  if (!p) {
    notify({ error: "this radar has not enabled sign-in" });
    return false;
  }
  if (!EMAIL_RE.test(addr)) {
    notify({ error: "that does not look like an email address" });
    return false;
  }
  notify({ busy: true, error: null });
  try {
    // Supabase's default email carries a link and no code until the operator
    // edits the template; the link must come back to THIS page or the
    // session it carries is dropped on a page that does not look for it.
    const target = redirectTarget();
    const path = target ? `/otp?redirect_to=${encodeURIComponent(target)}` : "/otp";
    const r = await gotrue(p, path, { body: { email: addr, create_user: true } }, fetchImpl);
    if (!r.ok) {
      notify({
        busy: false,
        error: r.status === 429 ? "too many codes requested — wait a minute and try again" : friendlyAuthError(messageOf(r.body, `sign-in refused (${r.status})`)),
      });
      return false;
    }
    notify({ busy: false, phase: "code-sent", email: addr });
    return true;
  } catch {
    notify({ busy: false, error: "could not reach the sign-in service" });
    return false;
  }
}

/** Step two: the code from the email, for a session. */
export async function verifyCode(code: string, fetchImpl: Fetch = fetch): Promise<boolean> {
  ensureRestored();
  const p = state.provider;
  const token = code.replace(/\s+/g, "");
  if (!p || state.phase !== "code-sent") return false;
  if (!CODE_RE.test(token)) {
    notify({ error: "the code is the digits from the email, nothing else" });
    return false;
  }
  notify({ busy: true, error: null });
  try {
    const r = await gotrue(p, "/verify", { body: { type: "email", email: state.email, token } }, fetchImpl);
    const s = r.ok ? sessionOf(p, r.body) : null;
    if (!s) {
      notify({
        busy: false,
        error: r.ok ? "the sign-in service returned no session" : friendlyAuthError(messageOf(r.body, "that code was not accepted — codes expire after an hour")),
      });
      return false;
    }
    writeSession(s);
    notify({ busy: false, phase: "in", user: s.user, email: s.user.email, error: null });
    return true;
  } catch {
    notify({ busy: false, error: "could not reach the sign-in service" });
    return false;
  }
}

/** Back from "enter the code" to "enter an email". */
export function cancelCode(): void {
  if (state.phase === "code-sent") notify({ phase: "out", error: null });
}

export async function signOut(fetchImpl: Fetch = fetch): Promise<void> {
  ensureRestored();
  const s = readSession();
  writeSession(null);
  notify({ phase: "out", user: null, me: null, meError: null, error: null, checkoutUrl: null, apiKeys: null, newKey: null, keysError: null });
  if (!s) return;
  try {
    await gotrue(s.auth, "/logout", { token: s.accessToken }, fetchImpl);
  } catch {
    /* the local session is gone either way */
  }
}

/**
 * The token the radar client hands over — refreshed first when it is
 * about to expire, single-flight so a burst of reconnects asks once.
 */
export async function accessToken(fetchImpl: Fetch = fetch): Promise<string | null> {
  const s = readSession();
  if (!s) return null;
  if (s.expiresAt - REFRESH_AHEAD_MS > Date.now()) return s.accessToken;
  if (!refreshing) {
    refreshing = refreshSession(s, fetchImpl).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function refreshSession(s: AccountSession, fetchImpl: Fetch): Promise<string | null> {
  const stillLive = () => (s.expiresAt > Date.now() ? s.accessToken : null);
  let r: GoTrueReply;
  try {
    r = await gotrue(s.auth, "/token?grant_type=refresh_token", { body: { refresh_token: s.refreshToken } }, fetchImpl);
  } catch {
    return stillLive(); // offline: the old token, while it lasts
  }
  const next = r.ok ? sessionOf(s.auth, r.body) : null;
  if (!next) {
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      // The refresh token is dead — revoked, rotated elsewhere, or too old.
      writeSession(null);
      notify({ phase: "out", user: null, me: null, error: "your session expired — sign in again" });
      return null;
    }
    return stillLive();
  }
  writeSession(next);
  if (state.phase !== "in" || state.user?.id !== next.user.id) notify({ phase: "in", user: next.user, email: next.user.email });
  return next.accessToken;
}

/**
 * The magic-link landing: Supabase's link puts the session in the URL
 * fragment. Adopt it after a /user check, so a forged fragment gets no
 * further than one refused request. The page clears the fragment.
 */
export async function adoptHashSession(hash: string, fetchImpl: Fetch = fetch): Promise<boolean> {
  ensureRestored();
  const p = state.provider;
  if (!p) return false;
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const desc = q.get("error_description");
  if (desc) {
    notify({ error: desc.replace(/\+/g, " ") });
    return false;
  }
  const access = q.get("access_token");
  const refresh = q.get("refresh_token");
  if (!access || !refresh) return false;
  const expiresAtS = Number(q.get("expires_at"));
  const expiresIn = Number(q.get("expires_in")) || 3600;
  notify({ busy: true, error: null });
  try {
    const r = await gotrue(p, "/user", { method: "GET", token: access }, fetchImpl);
    const u = (r.body ?? {}) as Record<string, unknown>;
    if (!r.ok || !str(u.id)) {
      notify({ busy: false, error: "the link's session was not accepted — request a code instead" });
      return false;
    }
    const s: AccountSession = {
      accessToken: access,
      refreshToken: refresh,
      expiresAt: expiresAtS > 0 ? expiresAtS * 1000 : Date.now() + expiresIn * 1000,
      user: { id: str(u.id), email: str(u.email) },
      auth: p,
    };
    writeSession(s);
    notify({ busy: false, phase: "in", user: s.user, email: s.user.email, error: null });
    return true;
  } catch {
    notify({ busy: false, error: "could not reach the sign-in service" });
    return false;
  }
}

// ----------------------------------------------------------- the radar

/** Who the radar thinks this session is, and whether it is paid up. */
export async function refreshMe(url: string, fetchImpl: Fetch = fetch): Promise<HostedMe | null> {
  const token = await accessToken(fetchImpl);
  if (!token) {
    notify({ me: null, meError: null });
    return null;
  }
  try {
    const me = await fetchMe(url, token, fetchImpl);
    notify({ me, meError: null });
    return me;
  } catch (err) {
    notify({
      me: null,
      meError:
        err instanceof HostedError && err.status === 401
          ? "this radar does not recognise the session — it may sign in through a different project"
          : err instanceof Error
            ? err.message
            : "could not reach the radar",
    });
    return null;
  }
}

/** After a checkout: ask /me until the webhook has landed, or give up. */
export async function awaitEntitlement(url: string, opts: { tries?: number; everyMs?: number } = {}, fetchImpl: Fetch = fetch): Promise<boolean> {
  const tries = opts.tries ?? 10;
  const everyMs = opts.everyMs ?? 3_000;
  for (let i = 0; i < tries; i++) {
    const me = await refreshMe(url, fetchImpl);
    if (me?.entitled) return true;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

export async function startCheckout(url: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  const token = await accessToken(fetchImpl);
  if (!token) return null;
  notify({ busy: true, error: null, checkoutUrl: null });
  try {
    const u = await fetchCheckoutUrl(url, token, fetchImpl);
    notify({ busy: false, checkoutUrl: u });
    return u;
  } catch (err) {
    notify({ busy: false, error: err instanceof Error ? err.message : "checkout could not be started" });
    return null;
  }
}

// ---------------------------------------------------------- API keys

export async function loadApiKeys(url: string, fetchImpl: Fetch = fetch): Promise<ApiKeyRow[] | null> {
  const token = await accessToken(fetchImpl);
  if (!token) {
    notify({ apiKeys: null, keysError: null });
    return null;
  }
  try {
    const keys = await fetchApiKeys(url, token, fetchImpl);
    notify({ apiKeys: keys, keysError: null });
    return keys;
  } catch (err) {
    notify({ apiKeys: null, keysError: err instanceof Error ? err.message : "could not read your keys" });
    return null;
  }
}

/** Mints a key and keeps it in the clear until dismissNewKey(). */
export async function mintApiKey(url: string, name: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  const token = await accessToken(fetchImpl);
  if (!token) return null;
  notify({ busy: true, keysError: null });
  try {
    const made = await createApiKey(url, token, name.trim(), fetchImpl);
    const { key, ...row } = made;
    notify({ busy: false, newKey: { key, prefix: row.prefix, name: row.name }, apiKeys: [...(state.apiKeys ?? []), row] });
    return key;
  } catch (err) {
    notify({ busy: false, keysError: err instanceof Error ? err.message : "the key could not be minted" });
    return null;
  }
}

export async function dropApiKey(url: string, id: string, fetchImpl: Fetch = fetch): Promise<boolean> {
  const token = await accessToken(fetchImpl);
  if (!token) return false;
  notify({ busy: true, keysError: null });
  try {
    const ok = await revokeApiKey(url, token, id, fetchImpl);
    notify({ busy: false, apiKeys: (state.apiKeys ?? []).filter((k) => k.id !== id), newKey: state.newKey && state.apiKeys?.find((k) => k.id === id)?.prefix === state.newKey.prefix ? null : state.newKey });
    return ok;
  } catch (err) {
    notify({ busy: false, keysError: err instanceof Error ? err.message : "the key could not be revoked" });
    return false;
  }
}

export function dismissNewKey(): void {
  if (state.newKey) notify({ newKey: null });
}

export async function openBillingPortal(url: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  const token = await accessToken(fetchImpl);
  if (!token) return null;
  notify({ busy: true, error: null });
  try {
    const u = await fetchPortalUrl(url, token, fetchImpl);
    notify({ busy: false, error: u ? null : "no billing record yet — subscribe first" });
    return u;
  } catch (err) {
    notify({ busy: false, error: err instanceof Error ? err.message : "the billing portal could not be opened" });
    return null;
  }
}
