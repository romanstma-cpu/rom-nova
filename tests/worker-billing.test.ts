// The billing desk: Stripe's form encoding, its webhook signature, what each
// event means for a reader's row, and the desk's four calls against a fake
// Stripe and a fake table. No key, no network.

import { describe, expect, it } from "vitest";
import {
  Billing,
  BillingError,
  encodeForm,
  entitledAt,
  parseSignatureHeader,
  periodEndOf,
  publicSubscription,
  signPayload,
  subscriptionPatchOf,
  verifyStripeSignature,
} from "../worker/src/billing.js";
import { fakeDb, fakeFetch, formOf, headerOf, workerConfig } from "./helpers/worker-config";

const SECRET = "whsec_test_secret";
const NOW_S = 1_788_000_000;

function signed(body: string, tS = NOW_S): string {
  return `t=${tS},v1=${signPayload(SECRET, tS, body)}`;
}

function stripeCfg() {
  return workerConfig({
    access: "subscription",
    stripeSecretKey: "sk_test_x",
    stripePriceId: "price_123",
    stripeWebhookSecret: SECRET,
  });
}

describe("encodeForm", () => {
  it("writes nested objects and arrays in Stripe's bracket notation and skips nulls", () => {
    const q = new URLSearchParams(
      encodeForm({
        mode: "subscription",
        line_items: [{ price: "price_1", quantity: 1 }],
        subscription_data: { metadata: { user_id: "u-1" } },
        customer: null,
        allow_promotion_codes: true,
      }),
    );
    expect(q.get("mode")).toBe("subscription");
    expect(q.get("line_items[0][price]")).toBe("price_1");
    expect(q.get("line_items[0][quantity]")).toBe("1");
    expect(q.get("subscription_data[metadata][user_id]")).toBe("u-1");
    expect(q.get("allow_promotion_codes")).toBe("true");
    expect(q.has("customer")).toBe(false);
  });
});

describe("webhook signatures", () => {
  const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated" });

  it("parses the header into its timestamp and v1 signatures", () => {
    expect(parseSignatureHeader("t=123,v1=abc,v0=zzz")).toEqual({ t: 123, v1: ["abc"] });
    expect(parseSignatureHeader("t=1,v1=a,v1=b")).toEqual({ t: 1, v1: ["a", "b"] });
    expect(parseSignatureHeader("garbage")).toEqual({ t: null, v1: [] });
    expect(parseSignatureHeader(undefined)).toEqual({ t: null, v1: [] });
  });

  it("accepts a signature it can reproduce, inside the tolerance", () => {
    expect(verifyStripeSignature(body, signed(body), SECRET, { nowS: NOW_S + 100 })).toEqual({ ok: true });
    // one good signature among stale ones still passes
    expect(verifyStripeSignature(body, `t=${NOW_S},v1=deadbeef,v1=${signPayload(SECRET, NOW_S, body)}`, SECRET, { nowS: NOW_S })).toEqual({ ok: true });
  });

  it("refuses a tampered body, a wrong secret, an old timestamp, a malformed header, or no secret", () => {
    expect(verifyStripeSignature(body + " ", signed(body), SECRET, { nowS: NOW_S }).ok).toBe(false);
    expect(verifyStripeSignature(body, signed(body), "whsec_other", { nowS: NOW_S }).ok).toBe(false);
    const old = verifyStripeSignature(body, signed(body, NOW_S - 301), SECRET, { nowS: NOW_S });
    expect(old).toEqual({ ok: false, reason: "signature timestamp outside tolerance" });
    expect(verifyStripeSignature(body, `t=${NOW_S}`, SECRET, { nowS: NOW_S }).ok).toBe(false);
    expect(verifyStripeSignature(body, signed(body), "", { nowS: NOW_S })).toEqual({ ok: false, reason: "no signing secret configured" });
  });
});

describe("what an event says about a row", () => {
  it("reads the period end from the top level or, on newer API versions, from the first item", () => {
    expect(periodEndOf({ current_period_end: 1_700_000_000 })).toBe(1_700_000_000);
    expect(periodEndOf({ items: { data: [{ current_period_end: 1_700_000_001 }] } })).toBe(1_700_000_001);
    expect(periodEndOf({ items: { data: [] } })).toBeNull();
    expect(periodEndOf(null)).toBeNull();
  });

  it("turns a paid checkout into an active row with the reader's id and Stripe's ids", () => {
    const p = subscriptionPatchOf({
      type: "checkout.session.completed",
      data: {
        object: {
          mode: "subscription",
          status: "complete",
          payment_status: "paid",
          client_reference_id: "user-1",
          customer: "cus_1",
          subscription: "sub_1",
          customer_details: { email: "a@b.c" },
        },
      },
    });
    expect(p).toEqual({ user_id: "user-1", email: "a@b.c", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", status: "active" });
  });

  it("marks an unpaid checkout incomplete and ignores one-off payments", () => {
    const unpaid = subscriptionPatchOf({
      type: "checkout.session.completed",
      data: { object: { mode: "subscription", status: "complete", payment_status: "unpaid", client_reference_id: "u" } },
    });
    expect(unpaid?.status).toBe("incomplete");
    expect(subscriptionPatchOf({ type: "checkout.session.completed", data: { object: { mode: "payment" } } })).toBeNull();
  });

  it("reads a subscription event's status, price, period end and cancellation flag", () => {
    const p = subscriptionPatchOf({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: { id: "cus_1" },
          status: "trialing",
          cancel_at_period_end: true,
          metadata: { user_id: "user-1" },
          items: { data: [{ price: { id: "price_123" }, current_period_end: 1_700_000_000 }] },
        },
      },
    });
    expect(p).toEqual({
      user_id: "user-1",
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_1",
      status: "trialing",
      price_id: "price_123",
      current_period_end: new Date(1_700_000_000_000).toISOString(),
      cancel_at_period_end: true,
    });
    expect(subscriptionPatchOf({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", status: "active" } } })?.status).toBe("canceled");
    expect(subscriptionPatchOf({ type: "invoice.paid", data: { object: {} } })).toBeNull();
  });
});

describe("entitlement", () => {
  const H = 3_600_000;
  const now = 1_788_000_000_000;
  const iso = (t: number) => new Date(t).toISOString();

  it("admits active and trialing, inside the period or the grace after it", () => {
    expect(entitledAt({ status: "active" }, now, 24 * H)).toBe(true);
    expect(entitledAt({ status: "trialing", current_period_end: iso(now + H) }, now, 24 * H)).toBe(true);
    expect(entitledAt({ status: "active", current_period_end: iso(now - 23 * H) }, now, 24 * H)).toBe(true);
    expect(entitledAt({ status: "active", current_period_end: iso(now - 25 * H) }, now, 24 * H)).toBe(false);
  });

  it("carries past_due only through the grace window, and nothing else at all", () => {
    expect(entitledAt({ status: "past_due", current_period_end: iso(now - H) }, now, 24 * H)).toBe(true);
    expect(entitledAt({ status: "past_due", current_period_end: iso(now - 25 * H) }, now, 24 * H)).toBe(false);
    expect(entitledAt({ status: "past_due" }, now, 24 * H)).toBe(false);
    expect(entitledAt({ status: "canceled", current_period_end: iso(now + H) }, now, 24 * H)).toBe(false);
    expect(entitledAt(null, now, 24 * H)).toBe(false);
  });

  it("shows the reader state and dates, never Stripe ids", () => {
    const pub = publicSubscription({ status: "active", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", current_period_end: iso(now), cancel_at_period_end: false });
    expect(pub).toEqual({ status: "active", current_period_end: iso(now), cancel_at_period_end: false, has_customer: true });
    expect(publicSubscription(null)).toBeNull();
  });
});

describe("the desk against a fake Stripe", () => {
  const user = { id: "user-1", email: "reader@example.com" };

  it("mints a checkout session for a new reader with their email, and reuses a known customer", async () => {
    const db = fakeDb();
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { url: "https://checkout.stripe.com/c/pay/cs_1" } }));
    const billing = new Billing(stripeCfg(), db, { fetchImpl, now: () => NOW_S * 1000 });
    expect(await billing.checkoutUrl(user)).toBe("https://checkout.stripe.com/c/pay/cs_1");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(headerOf(calls[0], "authorization")).toBe("Bearer sk_test_x");
    const form = formOf(calls[0]);
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("line_items[0][price]")).toBe("price_123");
    expect(form.get("client_reference_id")).toBe("user-1");
    expect(form.get("customer_email")).toBe("reader@example.com");
    expect(form.get("subscription_data[metadata][user_id]")).toBe("user-1");
    expect(form.get("success_url")).toBe("https://romapps.xyz/nova/account/?checkout=success");
    expect(form.has("customer")).toBe(false);

    db.store.set("user-1", { user_id: "user-1", stripe_customer_id: "cus_9", status: "canceled" });
    await billing.checkoutUrl(user);
    const again = formOf(calls[1]);
    expect(again.get("customer")).toBe("cus_9");
    expect(again.has("customer_email")).toBe(false);
  });

  it("caps checkout sessions per reader and refuses when billing is not configured", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { url: "https://checkout.stripe.com/x" } }));
    const billing = new Billing(stripeCfg(), fakeDb(), { fetchImpl, now: () => NOW_S * 1000 });
    for (let i = 0; i < 5; i++) await billing.checkoutUrl(user);
    await expect(billing.checkoutUrl(user)).rejects.toMatchObject({ status: 429 });
    const off = new Billing(workerConfig(), fakeDb(), { fetchImpl });
    expect(off.enabled).toBe(false);
    await expect(off.checkoutUrl(user)).rejects.toBeInstanceOf(BillingError);
  });

  it("opens the portal for a known customer and returns null before any purchase", async () => {
    const db = fakeDb([{ user_id: "user-1", stripe_customer_id: "cus_1", status: "active" }]);
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { url: "https://billing.stripe.com/p/session/x" } }));
    const billing = new Billing(stripeCfg(), db, { fetchImpl });
    expect(await billing.portalUrl({ id: "user-1" })).toBe("https://billing.stripe.com/p/session/x");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    expect(formOf(calls[0]).get("customer")).toBe("cus_1");
    expect(formOf(calls[0]).get("return_url")).toBe("https://romapps.xyz/nova/account/");
    expect(await billing.portalUrl({ id: "nobody" })).toBeNull();
  });

  it("reads the price from Stripe for /config, and survives not being able to", async () => {
    const ok = fakeFetch(() => ({ status: 200, body: { unit_amount: 900, currency: "usd", recurring: { interval: "month" } } }));
    const billing = new Billing(stripeCfg(), fakeDb(), { fetchImpl: ok.fetchImpl });
    expect(await billing.loadPrice()).toEqual({ amount: 900, currency: "usd", interval: "month" });
    expect(ok.calls[0].url).toBe("https://api.stripe.com/v1/prices/price_123");
    expect(billing.publicInfo()).toEqual({ enabled: true, price: { amount: 900, currency: "usd", interval: "month" } });

    const bad = fakeFetch(() => ({ status: 401, body: { error: { message: "Invalid API Key provided" } } }));
    const b2 = new Billing(stripeCfg(), fakeDb(), { fetchImpl: bad.fetchImpl });
    expect(await b2.loadPrice()).toBeNull();
    expect(b2.status().lastError).toContain("Invalid API Key");
  });

  it("applies signed webhooks in any order, and lets a subscription event's word stand over a checkout receipt", async () => {
    const db = fakeDb();
    const applied: string[] = [];
    const billing = new Billing(stripeCfg(), db, { now: () => NOW_S * 1000, onApplied: (id) => applied.push(id) });

    const checkout = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { mode: "subscription", status: "complete", payment_status: "paid", client_reference_id: "user-1", customer: "cus_1", subscription: "sub_1" } },
    });
    expect(await billing.handleWebhook(checkout, signed(checkout))).toEqual({ status: 200, body: { received: true, handled: true } });
    expect(db.store.get("user-1")).toMatchObject({ user_id: "user-1", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", status: "active" });
    expect(applied).toEqual(["user-1"]);

    const updated = JSON.stringify({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", customer: "cus_1", status: "trialing", metadata: { user_id: "user-1" }, items: { data: [{ price: { id: "price_123" }, current_period_end: NOW_S + 86_400 }] } } },
    });
    await billing.handleWebhook(updated, signed(updated));
    expect(db.store.get("user-1")).toMatchObject({ status: "trialing", price_id: "price_123", current_period_end: new Date((NOW_S + 86_400) * 1000).toISOString() });

    // Stripe redelivers the receipt: the subscription's own status stands.
    await billing.handleWebhook(checkout, signed(checkout));
    expect(db.store.get("user-1")?.status).toBe("trialing");

    // A later event with no metadata (a dashboard edit) still finds the reader by customer.
    const deleted = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", status: "canceled" } } });
    await billing.handleWebhook(deleted, signed(deleted));
    expect(db.store.get("user-1")?.status).toBe("canceled");
    // four deliveries, four writes, four cache forgets — the replay included
    expect(applied).toEqual(["user-1", "user-1", "user-1", "user-1"]);
    expect(billing.status()).toMatchObject({ webhooks: 4, applied: 4, rejected: 0 });
  });

  it("rejects a bad signature, ignores strangers, and asks Stripe to retry before the table exists", async () => {
    const db = fakeDb();
    const billing = new Billing(stripeCfg(), db, { now: () => NOW_S * 1000 });
    const body = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_x", customer: "cus_x", status: "active" } } });
    expect((await billing.handleWebhook(body, `t=${NOW_S},v1=00`)).status).toBe(400);
    const stranger = await billing.handleWebhook(body, signed(body));
    expect(stranger.status).toBe(200);
    expect(stranger.body.handled).toBe(false);
    expect(db.store.size).toBe(0);
    expect(billing.status().unmatched).toBe(1);

    db.billingReady = false;
    const checkout = JSON.stringify({ type: "checkout.session.completed", data: { object: { mode: "subscription", status: "complete", payment_status: "paid", client_reference_id: "u" } } });
    expect((await billing.handleWebhook(checkout, signed(checkout))).status).toBe(503);
    // an event we do not act on is acknowledged without touching the table
    const other = JSON.stringify({ type: "invoice.paid", data: { object: {} } });
    expect((await billing.handleWebhook(other, signed(other))).status).toBe(200);
  });
});
