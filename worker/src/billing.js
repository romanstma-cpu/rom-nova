// Stripe, over its REST API with fetch — no SDK, because the four calls this
// service makes (a Checkout Session, a Customer Portal session, a price
// read, and a webhook's signature) are small, and a fake fetch tests every
// one of them without a key.
//
// The shape of the money: one recurring price, set in Stripe's dashboard and
// named to the worker by STRIPE_PRICE_ID. A signed-in reader asks for a
// Checkout Session; Stripe hosts the card form; Stripe's webhook tells this
// process what happened; the subscriptions table remembers it; the feed's
// gate reads that table. The worker never sees a card number and never
// decides a price — it relays a session URL and believes signed webhooks.
//
// Idempotent on purpose: Stripe retries deliveries, and events arrive in no
// promised order. Every handler is an upsert keyed on the reader's user id,
// and a checkout receipt never overrides a status a subscription event set.

import { createHmac, timingSafeEqual } from "node:crypto";
import { log } from "../../src/lib/radar/engine/util.js";

export const STRIPE_API = "https://api.stripe.com/v1";
/** Stripe's own default: a signature older than five minutes is a replay. */
export const SIGNATURE_TOLERANCE_S = 300;
/** Checkout Sessions one reader may open per window — a click, not a loop. */
const CHECKOUTS_PER_WINDOW = 5;
const CHECKOUT_WINDOW_MS = 10 * 60_000;

/** Statuses that mean "the feed is paid for". past_due rides on grace, see entitledAt. */
export const ENTITLED_STATUSES = new Set(["active", "trialing"]);
/** Every status a subscription event can carry — what a checkout receipt must not overwrite. */
const SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]);

export class BillingError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class StripeError extends Error {
  /** @param {number} status @param {string} message @param {string} [code] */
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code ?? "";
  }
}

/**
 * Stripe's form encoding: nested objects and arrays as bracketed keys —
 * `line_items[0][price]=price_123`, `subscription_data[metadata][user_id]=…`.
 * @param {Record<string, any>} params
 */
export function encodeForm(params) {
  /** @type {[string, string][]} */
  const pairs = [];
  const walk = (value, key) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${key}[${i}]`));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}[${k}]` : k);
    } else {
      pairs.push([key, String(value)]);
    }
  };
  walk(params, "");
  return new URLSearchParams(pairs).toString();
}

export class StripeClient {
  /** @param {{ secretKey: string, fetchImpl?: typeof fetch }} opts */
  constructor({ secretKey, fetchImpl }) {
    this.key = secretKey;
    this.fetch = fetchImpl ?? globalThis.fetch;
  }

  /**
   * @param {"GET" | "POST"} method @param {string} path @param {Record<string, any>} [params]
   * @returns {Promise<any>} the decoded object; throws StripeError on a non-2xx
   */
  async request(method, path, params) {
    const res = await this.fetch(`${STRIPE_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.key}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: method === "POST" ? encodeForm(params ?? {}) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = body && typeof body === "object" ? body.error ?? {} : {};
      throw new StripeError(res.status, typeof e.message === "string" ? e.message : `stripe ${res.status}`, e.code);
    }
    return body;
  }
}

// ------------------------------------------------------------ signatures

/** @param {unknown} header @returns {{ t: number | null, v1: string[] }} */
export function parseSignatureHeader(header) {
  const out = { t: /** @type {number | null} */ (null), v1: /** @type {string[]} */ ([]) };
  for (const part of String(header ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") out.t = Number(v);
    else if (k === "v1" && v) out.v1.push(v);
  }
  return out;
}

/** HMAC-SHA256 of `${timestamp}.${rawBody}`, hex — what Stripe puts in v1. */
export function signPayload(secret, timestampS, rawBody) {
  return createHmac("sha256", secret).update(`${timestampS}.${rawBody}`).digest("hex");
}

/**
 * @param {string} rawBody the body bytes exactly as received — any reformatting breaks the signature
 * @param {unknown} header the Stripe-Signature header
 * @param {string} secret the endpoint's signing secret
 * @param {{ nowS?: number, toleranceS?: number }} [opts]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyStripeSignature(rawBody, header, secret, opts = {}) {
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  const toleranceS = opts.toleranceS ?? SIGNATURE_TOLERANCE_S;
  if (!secret) return { ok: false, reason: "no signing secret configured" };
  const { t, v1 } = parseSignatureHeader(header);
  if (t === null || !Number.isFinite(t) || v1.length === 0) return { ok: false, reason: "malformed Stripe-Signature header" };
  if (Math.abs(nowS - t) > toleranceS) return { ok: false, reason: "signature timestamp outside tolerance" };
  const expected = Buffer.from(signPayload(secret, t, rawBody), "hex");
  for (const sig of v1) {
    const given = Buffer.from(sig, "hex");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "no matching signature" };
}

// ------------------------------------------------------- event → row

/**
 * A subscription's period end, seconds since epoch. Top-level on API
 * versions before 2025-03-31, per line item from then on; a new Stripe
 * account gets the newer shape, an old one keeps the older.
 * @param {any} sub
 */
export function periodEndOf(sub) {
  const top = sub?.current_period_end;
  if (typeof top === "number" && Number.isFinite(top)) return top;
  const item = sub?.items?.data?.[0]?.current_period_end;
  return typeof item === "number" && Number.isFinite(item) ? item : null;
}

const idOf = (v) => (typeof v === "string" ? v : v && typeof v === "object" && typeof v.id === "string" ? v.id : null);

/**
 * What one webhook event says about one reader's subscription, as the
 * fields it can vouch for — null for an event this service does not act on.
 * @param {any} event
 * @returns {Record<string, any> | null}
 */
export function subscriptionPatchOf(event) {
  const type = event?.type;
  const obj = event?.data?.object;
  if (!obj || typeof obj !== "object") return null;

  if (type === "checkout.session.completed") {
    if (obj.mode !== "subscription") return null;
    const paid = obj.status === "complete" && (obj.payment_status === "paid" || obj.payment_status === "no_payment_required");
    return {
      user_id: (typeof obj.client_reference_id === "string" && obj.client_reference_id) || obj.metadata?.user_id || null,
      email: obj.customer_details?.email ?? obj.customer_email ?? null,
      stripe_customer_id: idOf(obj.customer),
      stripe_subscription_id: idOf(obj.subscription),
      status: paid ? "active" : "incomplete",
    };
  }

  if (type === "customer.subscription.created" || type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    const end = periodEndOf(obj);
    return {
      user_id: obj.metadata?.user_id || null,
      stripe_customer_id: idOf(obj.customer),
      stripe_subscription_id: idOf(obj),
      status: type === "customer.subscription.deleted" ? "canceled" : typeof obj.status === "string" ? obj.status : "unknown",
      price_id: obj.items?.data?.[0]?.price?.id ?? null,
      current_period_end: end === null ? null : new Date(end * 1000).toISOString(),
      cancel_at_period_end: obj.cancel_at_period_end === true,
    };
  }

  return null;
}

/**
 * Is this row paid up at `nowMs`? Active or trialing, yes. past_due only
 * inside the grace window after its period end (Stripe is retrying the
 * card; the reader has not left). Anything else, no.
 * @param {any} row @param {number} nowMs @param {number} graceMs
 */
export function entitledAt(row, nowMs, graceMs) {
  if (!row || typeof row.status !== "string") return false;
  const end = typeof row.current_period_end === "string" ? Date.parse(row.current_period_end) : NaN;
  const inGrace = !Number.isFinite(end) || end + graceMs > nowMs;
  if (ENTITLED_STATUSES.has(row.status)) return inGrace;
  if (row.status === "past_due") return Number.isFinite(end) && inGrace;
  return false;
}

/** The row as the reader may see it: state and dates, no Stripe ids. */
export function publicSubscription(row) {
  if (!row) return null;
  return {
    status: typeof row.status === "string" ? row.status : "none",
    current_period_end: typeof row.current_period_end === "string" ? row.current_period_end : null,
    cancel_at_period_end: row.cancel_at_period_end === true,
    has_customer: typeof row.stripe_customer_id === "string" && row.stripe_customer_id !== "",
  };
}

/** A patch minus the fields it cannot vouch for, so a merge never erases what an earlier event knew. */
function vouched(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

// ------------------------------------------------------------ the desk

export class Billing {
  /**
   * @param {import("./config.js").Config} cfg
   * @param {{ getSubscription: (id: string) => Promise<any>, findSubscriptionByCustomer: (c: string) => Promise<any>, upsertSubscription: (row: any) => Promise<void>, billingReady: boolean | null }} db
   * @param {{ fetchImpl?: typeof fetch, now?: () => number, onApplied?: (userId: string) => void }} [opts]
   */
  constructor(cfg, db, opts = {}) {
    this.cfg = cfg;
    this.db = db;
    this.now = opts.now ?? Date.now;
    this.onApplied = opts.onApplied ?? (() => {});
    this.stripe = cfg.stripeSecretKey ? new StripeClient({ secretKey: cfg.stripeSecretKey, fetchImpl: opts.fetchImpl }) : null;
    /** @type {{ amount: number | null, currency: string | null, interval: string | null } | null} */
    this.price = null;
    this.counts = { checkouts: 0, portals: 0, webhooks: 0, rejected: 0, unmatched: 0, applied: 0 };
    this.lastError = "";
    /** @type {Map<string, number[]>} */
    this.checkoutTimes = new Map();
  }

  get enabled() {
    return this.stripe !== null && this.cfg.stripePriceId !== "";
  }

  /** The price, from Stripe, so the app shows what Stripe will charge and not a string someone typed. */
  async loadPrice() {
    if (!this.enabled || !this.stripe) return null;
    try {
      const p = await this.stripe.request("GET", `/prices/${this.cfg.stripePriceId}`);
      this.price = {
        amount: typeof p.unit_amount === "number" ? p.unit_amount : null,
        currency: typeof p.currency === "string" ? p.currency : null,
        interval: typeof p.recurring?.interval === "string" ? p.recurring.interval : null,
      };
      log(`[billing] price ${this.cfg.stripePriceId}: ${this.price.amount} ${this.price.currency} / ${this.price.interval}`);
    } catch (err) {
      this.lastError = `price: ${err instanceof Error ? err.message : String(err)}`;
      log(`[billing] could not read the price — ${this.lastError}`);
    }
    return this.price;
  }

  /** What /config tells every visitor: is there something to buy, and what it costs. */
  publicInfo() {
    return { enabled: this.enabled, price: this.price };
  }

  /** @param {string} userId */
  allowCheckout(userId) {
    const now = this.now();
    const times = (this.checkoutTimes.get(userId) ?? []).filter((t) => now - t < CHECKOUT_WINDOW_MS);
    if (times.length >= CHECKOUTS_PER_WINDOW) return false;
    times.push(now);
    this.checkoutTimes.set(userId, times);
    return true;
  }

  /**
   * A Checkout Session for this reader. Their existing Stripe customer is
   * reused when the table knows one, so a lapsed subscriber who comes back
   * keeps one customer record and the portal keeps working.
   * @param {{ id: string, email: string }} user @returns {Promise<string>} the hosted checkout URL
   */
  async checkoutUrl(user) {
    if (!this.enabled || !this.stripe) throw new BillingError(503, "billing is not configured on this radar");
    if (!this.allowCheckout(user.id)) throw new BillingError(429, "too many checkout attempts — try again in a few minutes");
    const existing = await this.db.getSubscription(user.id);
    /** @type {Record<string, any>} */
    const params = {
      mode: "subscription",
      line_items: [{ price: this.cfg.stripePriceId, quantity: 1 }],
      client_reference_id: user.id,
      success_url: `${this.cfg.appUrl}/account/?checkout=success`,
      cancel_url: `${this.cfg.appUrl}/account/?checkout=cancel`,
      metadata: { user_id: user.id },
      subscription_data: { metadata: { user_id: user.id } },
      allow_promotion_codes: true,
    };
    if (existing?.stripe_customer_id) params.customer = existing.stripe_customer_id;
    else if (user.email) params.customer_email = user.email;
    const session = await this.stripe.request("POST", "/checkout/sessions", params);
    if (typeof session.url !== "string") throw new StripeError(502, "checkout session carried no URL");
    this.counts.checkouts++;
    return session.url;
  }

  /**
   * A Customer Portal session — cancel, change card, download invoices —
   * or null when Stripe has never heard of this reader.
   * @param {{ id: string }} user @returns {Promise<string | null>}
   */
  async portalUrl(user) {
    if (!this.enabled || !this.stripe) throw new BillingError(503, "billing is not configured on this radar");
    const existing = await this.db.getSubscription(user.id);
    if (!existing?.stripe_customer_id) return null;
    const s = await this.stripe.request("POST", "/billing_portal/sessions", {
      customer: existing.stripe_customer_id,
      return_url: `${this.cfg.appUrl}/account/`,
    });
    if (typeof s.url !== "string") throw new StripeError(502, "portal session carried no URL");
    this.counts.portals++;
    return s.url;
  }

  /**
   * One delivery from Stripe. Returns the HTTP status and body to answer
   * with: 400 for a bad signature (Stripe will not retry), 503 while the
   * table is missing (Stripe retries for days — the migration can land
   * meanwhile), 200 once the row is written or the event is not ours.
   * @param {string} rawBody @param {unknown} signatureHeader
   * @returns {Promise<{ status: number, body: Record<string, any> }>}
   */
  async handleWebhook(rawBody, signatureHeader) {
    this.counts.webhooks++;
    const v = verifyStripeSignature(rawBody, signatureHeader, this.cfg.stripeWebhookSecret, { nowS: Math.floor(this.now() / 1000) });
    if (!v.ok) {
      this.counts.rejected++;
      log(`[billing] webhook rejected: ${v.reason}`);
      return { status: 400, body: { error: v.reason } };
    }
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      this.counts.rejected++;
      return { status: 400, body: { error: "body is not JSON" } };
    }
    const patch = subscriptionPatchOf(event);
    if (!patch) return { status: 200, body: { received: true, handled: false } };
    if (this.db.billingReady !== true) {
      this.lastError = "webhook before the subscriptions table exists";
      return { status: 503, body: { error: "billing table not ready — run the accounts migration" } };
    }

    let existing = patch.user_id ? await this.db.getSubscription(patch.user_id) : null;
    if (!existing && patch.stripe_customer_id) existing = await this.db.findSubscriptionByCustomer(patch.stripe_customer_id);
    const userId = patch.user_id ?? existing?.user_id ?? null;
    if (!userId) {
      this.counts.unmatched++;
      log(`[billing] ${event.type} for customer ${patch.stripe_customer_id ?? "?"} matches no reader — ignored`);
      return { status: 200, body: { received: true, handled: false, reason: "no reader for this customer" } };
    }
    // A checkout receipt says "paid"; the subscription events say what the
    // subscription IS. When both have landed, the subscription's word stands.
    if (event.type === "checkout.session.completed" && existing && SUBSCRIPTION_STATUSES.has(existing.status)) delete patch.status;

    const row = { ...(existing ?? {}), ...vouched(patch), user_id: userId, updated_at: new Date(this.now()).toISOString() };
    await this.db.upsertSubscription(row);
    this.counts.applied++;
    this.onApplied(userId);
    log(`[billing] ${event.type}: reader ${userId.slice(0, 8)}… is ${row.status}${row.current_period_end ? ` until ${row.current_period_end}` : ""}`);
    return { status: 200, body: { received: true, handled: true } };
  }

  status() {
    return {
      enabled: this.enabled,
      price: this.price,
      ...this.counts,
      lastError: this.lastError || null,
    };
  }
}
