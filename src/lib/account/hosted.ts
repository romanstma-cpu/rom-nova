"use client";

// The hosted radar's account routes, as the app calls them.
//
// A Radar worker (worker/ in this repo) can run open, or behind a sign-in,
// or behind a subscription (its RADAR_ACCESS). ROM runs one at
// HOSTED_RADAR_URL. Everything the app needs to know about a radar's gate
// comes from the radar itself over /config — which Supabase project signs
// people in, whether there is something to buy and what it costs — so the
// app ships no key and no price, and points at whatever worker the reader
// typed on the radar page.
//
// Every response is normalized field by field before it touches state:
// data from a user-configured server, never trusted to be well-formed.

export const HOSTED_RADAR_URL = "https://rom-nova-radar.onrender.com";

export type AccessMode = "open" | "account" | "subscription";

export interface HostedPrice {
  /** minor units, as Stripe stores them — 900 is $9.00 */
  amount: number | null;
  currency: string | null;
  interval: string | null;
}

export interface HostedConfig {
  url: string;
  access: AccessMode;
  /** where sign-in goes: the radar's Supabase project, with its public key */
  auth: { url: string; anonKey: string } | null;
  billing: { enabled: boolean; price: HostedPrice | null };
  appUrl: string | null;
}

export interface HostedSubscription {
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  has_customer: boolean;
}

export interface HostedMe {
  access: AccessMode;
  user: { id: string; email: string } | null;
  entitled: boolean;
  subscription: HostedSubscription | null;
  billing_ready: boolean;
}

export class HostedError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);

const accessOf = (v: unknown): AccessMode => (v === "account" || v === "subscription" ? v : "open");

export function normHostedConfig(url: string, raw: unknown): HostedConfig {
  const o = obj(raw) ?? {};
  const a = obj(o.auth);
  const auth = a && str(a.url) && str(a.anon_key) ? { url: str(a.url).replace(/\/+$/, ""), anonKey: str(a.anon_key) } : null;
  const b = obj(o.billing);
  const p = obj(b?.price);
  return {
    url,
    access: accessOf(o.access),
    auth,
    billing: {
      enabled: b?.enabled === true,
      price: p ? { amount: numOrNull(p.amount), currency: strOrNull(p.currency), interval: strOrNull(p.interval) } : null,
    },
    appUrl: strOrNull(o.app_url),
  };
}

export function normHostedMe(raw: unknown): HostedMe {
  const o = obj(raw) ?? {};
  const u = obj(o.user);
  const s = obj(o.subscription);
  return {
    access: accessOf(o.access),
    user: u && str(u.id) ? { id: str(u.id), email: str(u.email) } : null,
    entitled: o.entitled === true,
    subscription: s
      ? {
          status: str(s.status) || "none",
          current_period_end: strOrNull(s.current_period_end),
          cancel_at_period_end: s.cancel_at_period_end === true,
          has_customer: s.has_customer === true,
        }
      : null,
    billing_ready: o.billing_ready === true,
  };
}

/** The radar's error line, when it sent one. */
function errorOf(body: unknown): string | null {
  const o = obj(body);
  return o && typeof o.error === "string" && o.error ? o.error : null;
}

type Fetch = typeof fetch;

export async function fetchHostedConfig(url: string, fetchImpl: Fetch = fetch): Promise<HostedConfig> {
  const res = await fetchImpl(`${url}/config`);
  if (!res.ok) throw new HostedError(res.status, `the radar answered ${res.status} to /config`);
  return normHostedConfig(url, await res.json());
}

export async function fetchMe(url: string, token: string, fetchImpl: Fetch = fetch): Promise<HostedMe> {
  const res = await fetchImpl(`${url}/me`, { headers: { authorization: `Bearer ${token}` } });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new HostedError(res.status, errorOf(body) ?? `the radar answered ${res.status}`);
  return normHostedMe(body);
}

async function fetchSessionUrl(url: string, path: string, token: string, fetchImpl: Fetch): Promise<{ status: number; url: string | null; error: string | null }> {
  const res = await fetchImpl(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const body: unknown = await res.json().catch(() => null);
  const o = obj(body);
  return { status: res.status, url: o && typeof o.url === "string" && /^https:\/\//.test(o.url) ? o.url : null, error: errorOf(body) };
}

/** A Stripe Checkout URL for this session, minted by the radar. */
export async function fetchCheckoutUrl(url: string, token: string, fetchImpl: Fetch = fetch): Promise<string> {
  const r = await fetchSessionUrl(url, "/billing/checkout", token, fetchImpl);
  if (!r.url) throw new HostedError(r.status, r.error ?? `checkout could not be started (${r.status})`);
  return r.url;
}

/** A Stripe Customer Portal URL, or null before the reader has ever bought. */
export async function fetchPortalUrl(url: string, token: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  const r = await fetchSessionUrl(url, "/billing/portal", token, fetchImpl);
  if (r.status === 404) return null;
  if (!r.url) throw new HostedError(r.status, r.error ?? `the billing portal could not be opened (${r.status})`);
  return r.url;
}

const ZERO_DECIMAL = new Set(["jpy", "krw", "vnd", "clp", "isk", "huf", "twd"]);

/** "$9.00 / month", from what Stripe said — or null when the radar had no price to show. */
export function fmtPrice(p: HostedPrice | null): string | null {
  if (!p || p.amount === null || !p.currency) return null;
  const code = p.currency.toUpperCase();
  const major = ZERO_DECIMAL.has(p.currency.toLowerCase()) ? p.amount : p.amount / 100;
  let money: string;
  try {
    money = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(major);
  } catch {
    money = `${major} ${code}`;
  }
  return p.interval ? `${money} / ${p.interval}` : money;
}
