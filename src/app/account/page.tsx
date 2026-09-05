"use client";

// The account page: the one page in Nova that knows who you are, and only
// because a hosted radar asked.
//
// Everything else in the app runs without a name. This page exists for a
// Radar worker that gates its feed — ROM's hosted one, or the reader's own
// with RADAR_ACCESS set — and it reads the gate from the radar itself: an
// open radar gets a page that says so and offers nothing to sign in to; a
// radar behind a subscription gets the price Stripe reported, a Subscribe
// button that opens Stripe's own checkout page in a new tab, and a Manage
// button for the portal. The card form is Stripe's; the app and the radar
// never see a card.

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { PageTitle } from "@/components/ui/PageTitle";
import {
  accountServerSnapshot,
  accountSnapshot,
  adoptHashSession,
  awaitEntitlement,
  cancelCode,
  dismissNewKey,
  dropApiKey,
  loadApiKeys,
  loadHosted,
  mintApiKey,
  openBillingPortal,
  refreshMe,
  requestCode,
  signOut,
  startCheckout,
  subscribeAccount,
  verifyCode,
} from "@/lib/account/auth";
import { fmtPrice, HOSTED_RADAR_URL } from "@/lib/account/hosted";
import { holdRadar, radarConnect, radarReconnect, radarServerSnapshot, radarSnapshot, subscribeRadar } from "@/lib/radar/client";

// The ?checkout= return from Stripe, through the store seam so the
// prerendered page and the browser's first paint agree.
const noSubscribe = () => () => {};
const checkoutReturn = (): string | null => {
  try {
    return new URLSearchParams(window.location.search).get("checkout");
  } catch {
    return null;
  }
};
const checkoutReturnServer = (): string | null => null;

const STATUS_WORDS: Record<string, string> = {
  active: "active",
  trialing: "on trial",
  past_due: "payment overdue",
  canceled: "cancelled",
  unpaid: "unpaid",
  incomplete: "payment not completed",
  incomplete_expired: "payment lapsed",
  paused: "paused",
  none: "none",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
}

/** Open Stripe in a new tab; on the desktop app that is the system browser. */
function openExternal(url: string): boolean {
  try {
    const w = window.open(url, "_blank", "noopener,noreferrer");
    return w !== null;
  } catch {
    return false;
  }
}

export default function AccountPage() {
  const acct = useSyncExternalStore(subscribeAccount, accountSnapshot, accountServerSnapshot);
  const radar = useSyncExternalStore(subscribeRadar, radarSnapshot, radarServerSnapshot);
  const returned = useSyncExternalStore(noSubscribe, checkoutReturn, checkoutReturnServer);
  const [emailDraft, setEmailDraft] = useState("");
  const [codeDraft, setCodeDraft] = useState("");
  const [keyName, setKeyName] = useState("");
  const [copied, setCopied] = useState(false);
  /** The receipt's fate once Stripe has been asked: null while we still ask. */
  const [confirmed, setConfirmed] = useState<"done" | "slow" | null>(null);

  const radarUrl = radar.url || HOSTED_RADAR_URL;
  const hosted = acct.hosted;
  const signedIn = acct.phase === "in";
  const workerUp = radar.phase === "connected";

  // Hold the radar (so its state here is live), read the radar's /config,
  // adopt a magic-link landing if this is one, then ask who we are.
  useEffect(() => {
    const release = holdRadar();
    const url = radarSnapshot().url || HOSTED_RADAR_URL;
    const hash = window.location.hash;
    void loadHosted(url).then(async () => {
      if (hash.includes("access_token=")) {
        await adoptHashSession(hash);
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      await refreshMe(url);
      if (accountSnapshot().me?.user && accountSnapshot().hosted?.api.keys) await loadApiKeys(url);
    });
    return release;
  }, []);

  // Back from Stripe with a receipt: the webhook lands within seconds; ask
  // until it has, then let the radar back in.
  useEffect(() => {
    if (returned !== "success" || !signedIn) return;
    let dead = false;
    void awaitEntitlement(radarUrl).then((ok) => {
      if (dead) return;
      setConfirmed(ok ? "done" : "slow");
      if (ok) radarReconnect();
    });
    return () => {
      dead = true;
    };
  }, [returned, signedIn, radarUrl]);
  const confirming: "waiting" | "done" | "slow" | null = returned === "success" && signedIn ? (confirmed ?? "waiting") : null;

  // A tab that regains focus after the portal or checkout: re-read.
  useEffect(() => {
    if (!signedIn) return;
    const onFocus = () => void refreshMe(radarUrl);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [signedIn, radarUrl]);

  const me = acct.me;
  const sub = me?.subscription ?? null;
  const price = fmtPrice(hosted?.billing.price ?? null);
  const gateWord = hosted?.access === "subscription" ? "a subscription" : hosted?.access === "account" ? "a sign-in" : "nothing";

  return (
    <div className="p-3 flex flex-col gap-3 max-w-[860px]">
      <div className="flex items-center gap-2 flex-wrap">
        <PageTitle title="ACCOUNT" lede="Sign in for the hosted radar; nothing else in Nova needs one" />
      </div>

      {/* the radar this page is about */}
      <div className="panel p-3.5 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="panel-title">Hosted radar</span>
          <span className={`chip text-[9.5px] ${workerUp ? "chip-pos" : ""}`}>
            {workerUp ? "CONNECTED" : radar.phase === "connecting" ? "CONNECTING…" : radar.phase === "error" ? "NOT CONNECTED" : "not connected"}
          </span>
          {hosted && <span className="chip text-[9.5px]">{hosted.access === "open" ? "open to anyone" : `needs ${gateWord}`}</span>}
        </div>
        <div className="text-[11.5px] dim leading-relaxed">
          A Radar worker on a server hunts while this app is closed and pushes what it finds to the{" "}
          <Link href="/radar" className="link">
            Whale Radar
          </Link>{" "}
          page. This page talks to <span className="num text-[var(--text)]">{radarUrl}</span>
          {radar.url && radar.url !== HOSTED_RADAR_URL ? " — the worker you set on the radar page." : " — ROM's hosted one."}{" "}
          {acct.hostedError ? (
            <span className="warn">It did not answer: {acct.hostedError}.</span>
          ) : hosted ? (
            hosted.access === "open" ? (
              "It asks for nothing: anyone with the URL can read its feed, and there is nothing here to sign in to."
            ) : (
              `Its feed is behind ${gateWord}.`
            )
          ) : (
            "Reading its configuration…"
          )}
        </div>
        {radar.gate === "signin" && !signedIn && <div className="text-[11px] warn">The radar refused the last connection: sign in below, and it reconnects.</div>}
        {radar.gate === "subscribe" && <div className="text-[11px] warn">The radar refused the last connection: it needs a subscription — see the plan below.</div>}
        {radar.gate === "unavailable" && <div className="text-[11px] warn">The radar could not verify the sign-in just now; it keeps retrying.</div>}
        {radar.error && !radar.gate && radar.phase === "error" && <div className="text-[11px] text-[var(--danger)]">{radar.error}</div>}
        <div className="flex gap-2 flex-wrap">
          {!workerUp && (
            <button type="button" className="btn btn-primary text-[11px]" onClick={() => radarConnect(radarUrl)} disabled={radar.phase === "connecting"}>
              {radar.phase === "connecting" ? "CONNECTING…" : "CONNECT THIS RADAR"}
            </button>
          )}
          {workerUp && (
            <Link href="/radar" className="btn text-[11px]">
              OPEN THE RADAR →
            </Link>
          )}
        </div>
      </div>

      {/* sign-in */}
      <div className="panel p-3.5 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="panel-title">Sign in</span>
          <span className={`chip text-[9.5px] ${signedIn ? "chip-pos" : ""}`}>{signedIn ? "signed in" : acct.phase === "code-sent" ? "code sent" : "signed out"}</span>
        </div>
        {signedIn ? (
          <>
            <div className="text-[12px]">
              Signed in as <span className="num">{acct.user?.email || acct.user?.id}</span>
              {me?.user && me.user.id === acct.user?.id ? <span className="faint"> · recognised by the radar</span> : acct.meError ? <span className="warn"> · {acct.meError}</span> : null}
            </div>
            <div className="flex gap-2 flex-wrap">
              <button type="button" className="btn text-[11px]" onClick={() => void signOut()} disabled={acct.busy}>
                SIGN OUT
              </button>
            </div>
          </>
        ) : !acct.provider ? (
          <div className="text-[11.5px] dim leading-relaxed">
            {hosted?.access === "open"
              ? "Nothing to sign in to — this radar is open."
              : acct.hostedError
                ? "Sign-in will appear once the radar answers."
                : "This radar has not enabled sign-in."}
          </div>
        ) : acct.phase === "code-sent" ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void verifyCode(codeDraft).then((ok) => {
                if (ok) {
                  setCodeDraft("");
                  void refreshMe(radarUrl).then(() => {
                    radarReconnect();
                    if (accountSnapshot().hosted?.api.keys) void loadApiKeys(radarUrl);
                  });
                }
              });
            }}
          >
            <div className="text-[11.5px] dim leading-relaxed">
              A code went to <span className="num text-[var(--text)]">{acct.email}</span>. Enter it here. If the email carries a link
              instead of a code, the link works too on the web version of this page.
            </div>
            <div className="flex gap-2 flex-wrap items-center">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={codeDraft}
                onChange={(e) => setCodeDraft(e.target.value)}
                placeholder="123456"
                className="input num text-[13px] tracking-[0.2em] w-[160px]"
                aria-label="Sign-in code"
              />
              <button type="submit" className="btn btn-primary text-[11px]" disabled={acct.busy || codeDraft.replace(/\s+/g, "").length < 6}>
                {acct.busy ? "CHECKING…" : "SIGN IN"}
              </button>
              <button type="button" className="btn text-[11px]" onClick={cancelCode} disabled={acct.busy}>
                use another address
              </button>
            </div>
          </form>
        ) : (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void requestCode(emailDraft);
            }}
          >
            <div className="text-[11.5px] dim leading-relaxed">
              No password. Enter your email; a six-digit code arrives; enter that. The sign-in itself is Supabase Auth, on the
              radar operator&apos;s project — your address is stored there and nowhere else.
            </div>
            <div className="flex gap-2 flex-wrap items-center">
              <input
                type="email"
                autoComplete="email"
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                placeholder="you@example.com"
                className="input text-[12.5px] flex-1 min-w-[220px]"
                aria-label="Email address"
              />
              <button type="submit" className="btn btn-primary text-[11px]" disabled={acct.busy || !emailDraft.includes("@")}>
                {acct.busy ? "SENDING…" : "SEND CODE"}
              </button>
            </div>
          </form>
        )}
        {acct.error && <div className="text-[11px] text-[var(--danger)]">{acct.error}</div>}
      </div>

      {/* the plan, only where there is one */}
      {hosted?.access === "subscription" && (
        <div className="panel p-3.5 flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="panel-title">Plan</span>
            {signedIn && me && (
              <span className={`chip text-[9.5px] ${me.entitled ? "chip-pos" : ""}`}>
                {me.entitled ? "PAID UP" : sub ? STATUS_WORDS[sub.status] ?? sub.status : "no subscription"}
              </span>
            )}
            {price && <span className="chip text-[9.5px] num">{price}</span>}
          </div>
          <div className="text-[11.5px] dim leading-relaxed">
            The hosted radar hunts around the clock; the subscription keeps that server up. {price ? `${price}, ` : "The price is shown at checkout, "}
            cancel any time from the billing portal, and the feed stays open to the end of the paid period. Payment is on
            Stripe&apos;s own page; neither this app nor the radar sees a card.
          </div>
          {!signedIn ? (
            <div className="text-[11px] warn">Sign in above first.</div>
          ) : !hosted.billing.enabled || (me && !me.billing_ready) ? (
            <div className="text-[11px] warn">Billing is not set up on this radar yet — nothing can be bought from it today.</div>
          ) : (
            <>
              {sub && (
                <div className="text-[11.5px]">
                  Status: <span className="num">{STATUS_WORDS[sub.status] ?? sub.status}</span>
                  {sub.current_period_end && (
                    <span className="dim">
                      {" "}
                      · {sub.cancel_at_period_end ? "ends" : "renews"} {fmtDate(sub.current_period_end)}
                    </span>
                  )}
                </div>
              )}
              {confirming === "waiting" && <div className="text-[11px] warn">Thanks — confirming the payment with Stripe…</div>}
              {confirming === "done" && <div className="text-[11px] pos">Confirmed. The radar is yours; it is reconnecting now.</div>}
              {confirming === "slow" && (
                <div className="text-[11px] warn">
                  Stripe has not reported the payment to the radar yet. It usually takes seconds; come back to this page in a minute.
                </div>
              )}
              <div className="flex gap-2 flex-wrap items-center">
                {!me?.entitled && (
                  <button
                    type="button"
                    className="btn btn-primary text-[11px]"
                    disabled={acct.busy}
                    onClick={() => {
                      void startCheckout(radarUrl).then((url) => {
                        if (url) openExternal(url);
                      });
                    }}
                  >
                    {acct.busy ? "ONE MOMENT…" : "SUBSCRIBE ON STRIPE →"}
                  </button>
                )}
                {sub?.has_customer && (
                  <button
                    type="button"
                    className="btn text-[11px]"
                    disabled={acct.busy}
                    onClick={() => {
                      void openBillingPortal(radarUrl).then((url) => {
                        if (url) openExternal(url);
                      });
                    }}
                  >
                    MANAGE BILLING
                  </button>
                )}
                <button type="button" className="btn text-[11px]" disabled={acct.busy} onClick={() => void refreshMe(radarUrl)}>
                  refresh
                </button>
              </div>
              {acct.checkoutUrl && (
                <div className="text-[11px] dim">
                  If Stripe did not open,{" "}
                  <a className="link" href={acct.checkoutUrl} target="_blank" rel="noopener noreferrer">
                    continue to checkout here
                  </a>
                  .
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* API keys, where the radar issues them: a gated radar, a signed-in reader */}
      {signedIn && hosted?.api.keys && (
        <div className="panel p-3.5 flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="panel-title">API access</span>
            <span className="chip text-[9.5px]">{acct.apiKeys ? `${acct.apiKeys.length} key${acct.apiKeys.length === 1 ? "" : "s"}` : "reading…"}</span>
            {hosted.api.ratePerMin !== null && <span className="chip text-[9.5px] num">{hosted.api.ratePerMin} requests / min</span>}
          </div>
          <div className="text-[11.5px] dim leading-relaxed">
            Everything the radar pushes, as JSON for your own scripts: signals with their grades and exits, the leaderboard,
            launches, whales, fills, behaviours, and signal history. A key stands in for this sign-in
            {hosted.access === "subscription" ? " and works while the plan is active" : ""}. It is shown once; the radar keeps
            only a hash.{" "}
            {hosted.api.docs && (
              <a className="link" href={hosted.api.docs} target="_blank" rel="noopener noreferrer">
                API reference ↗
              </a>
            )}
          </div>
          {acct.newKey && (
            <div className="panel p-3 flex flex-col gap-1.5" style={{ borderColor: "rgba(56,225,255,0.35)" }}>
              <div className="text-[11px] warn">Copy this key now. It will not be shown again.</div>
              <div className="flex items-center gap-2 flex-wrap">
                <code className="num text-[12px] break-all">{acct.newKey.key}</code>
                <button
                  type="button"
                  className="btn text-[11px]"
                  onClick={() => {
                    const nk = acct.newKey;
                    if (nk) void navigator.clipboard?.writeText(nk.key).then(() => setCopied(true));
                  }}
                >
                  {copied ? "COPIED" : "COPY"}
                </button>
                <button
                  type="button"
                  className="btn text-[11px]"
                  onClick={() => {
                    dismissNewKey();
                    setCopied(false);
                  }}
                >
                  done
                </button>
              </div>
              <pre className="num text-[10.5px] dim whitespace-pre-wrap break-all m-0">{`curl -H "Authorization: Bearer ${acct.newKey.key}" "${radarUrl}/api/v1/signals?limit=20"`}</pre>
            </div>
          )}
          {acct.apiKeys && acct.apiKeys.length > 0 && (
            <div className="flex flex-col">
              {acct.apiKeys.map((k) => (
                <div key={k.id} className="flex items-center gap-3 flex-wrap py-1.5 border-b border-[rgba(27,35,51,0.5)] text-[11.5px]">
                  <span className="num">{k.prefix}</span>
                  <span className="dim">{k.name || "unnamed"}</span>
                  <span className="faint num text-[10.5px]">
                    made {fmtDate(k.created_at)}
                    {k.last_used_at ? ` · used ${fmtDate(k.last_used_at)}` : " · never used"}
                  </span>
                  <button type="button" className="btn text-[10.5px] ml-auto" disabled={acct.busy} onClick={() => void dropApiKey(radarUrl, k.id)}>
                    revoke
                  </button>
                </div>
              ))}
            </div>
          )}
          <form
            className="flex gap-2 flex-wrap items-center"
            onSubmit={(e) => {
              e.preventDefault();
              void mintApiKey(radarUrl, keyName).then((k) => {
                if (k) {
                  setKeyName("");
                  setCopied(false);
                }
              });
            }}
          >
            <input
              type="text"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="what this key is for (optional)"
              maxLength={60}
              className="input text-[12px] flex-1 min-w-[220px]"
              aria-label="Key name"
            />
            <button type="submit" className="btn btn-primary text-[11px]" disabled={acct.busy || (hosted.access === "subscription" && !me?.entitled)}>
              NEW KEY
            </button>
          </form>
          {hosted.access === "subscription" && !me?.entitled && <div className="text-[11px] warn">Keys need an active plan.</div>}
          {acct.keysError && <div className="text-[11px] text-[var(--danger)]">{acct.keysError}</div>}
        </div>
      )}

      <div className="panel p-3.5 text-[11.5px] dim leading-relaxed">
        <span className="panel-title block mb-1.5">What this page stores, and where</span>
        Your email, with the sign-in provider (Supabase Auth) on the radar operator&apos;s project, and a session in this browser
        that the radar client presents when it connects. If you subscribe, a Stripe customer id beside it, so the portal can
        find you. Card details go to Stripe&apos;s page and never touch this app or the radar. Nothing else in Nova reads any of
        this — the scanner, the ledger, the desk and the in-app radar keep working with no account at all, and signing out
        here leaves all of that untouched. See{" "}
        <Link href="/legal" className="link">
          the disclaimer
        </Link>{" "}
        for the full statement.
      </div>
    </div>
  );
}
