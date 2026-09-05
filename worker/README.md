# ROM Nova Radar

The autonomous whale scanner. It runs on a server, watches Solana around the
clock, and pushes what it finds into the ROM Nova app's **Whale Radar** page
over Socket.io. The app works fully without it — this adds the plane that
keeps watching while your machine is off.

## What it does, measured claims only

- **Watches every pump.fun launch** — PumpPortal's keyless creation stream
  (27–58 launches/min, no timestamp on the frame, so launch times are the
  worker's receipt clock).
- **Sees every pump.fun bonding-curve trade** — one keyless `logsSubscribe`
  on the pump.fun program at publicnode (~220 notifications/s, ~34 decoded
  trades/s, probed 2026-09-03). No per-wallet subscription budget exists,
  because there are no per-wallet subscriptions.
- **Discovers whales**: a buy of `WHALE_THRESHOLD_SOL`+ (default 10) within
  `WHALE_WINDOW_MIN` (default 10 min) of a launch it saw marks the wallet.
- **Journals and scores them**: every observed fill by a tracked wallet is
  recorded; realized PNL uses average cost over OBSERVED buys only. Sells of
  tokens the worker never saw bought are journaled but excluded from PNL and
  counted as `unmeasured_sells` — no invented cost basis, ever.
- **Signals**: when a wallet whose score already exceeds
  `SIGNAL_MIN_SCORE` (default 70, with at least `SIGNAL_MIN_SETTLED` settled
  sells) buys at least `SIGNAL_MIN_BUY_SOL`, a signal row is written and
  pushed to every connected client. The score used is the one the wallet had
  BEFORE the triggering buy.
- **Survives restarts**: on boot it reloads tracked wallets and replays their
  journaled fills from Supabase, so scores are not reset by a redeploy.

### What it does NOT do

- No trading, no keys to any wallet, no execution of anything. It observes.
- Coverage boundary: without `HELIUS_API_KEY`, trades after a token migrates
  off the bonding curve (PumpSwap/Raydium/aggregators) are **not observed**.
  With the key, the worker follows its top wallets' off-curve activity too
  (the Helius path ships structurally tested but has not run against a live
  key from this codebase — watch `/health` the first hours you enable it).
- Scores need runtime to mean anything. A fresh deploy has no proven wallets;
  expect the first legitimate 70+ scores after wallets complete several
  settled round trips. That is the honesty working, not a bug.

## Setup

1. **Supabase** (free): create a project → SQL editor → paste
   [`supabase/schema.sql`](supabase/schema.sql) → Run. Copy the project URL
   and the `service_role` key from Project Settings → API.
2. **Render** (free): New → Blueprint → this repo. Render reads
   [`render.yaml`](../render.yaml) and prompts for `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY`, and optional `HELIUS_API_KEY` — paste them in
   Render's dashboard yourself.
   - Free plan sleeps after ~15 idle minutes (no inbound HTTP). For true
     24/7: starter plan, or a free uptime monitor pinging `/health` every
     5 minutes.
3. **Connect the app**: ROM Nova → Whale Radar page → paste the service URL
   (e.g. `https://rom-nova-radar.onrender.com`) → CONNECT. The URL is stored
   in your browser only.

## Upgrading to 1.17.0 (grades, exits, copyability)

A database created from the earlier `schema.sql` lacks the copy-desk
columns. The worker notices: `/health` shows `db.schema` as
`migration pending — run worker/supabase/migrations/002-copy-desk.sql` and it
keeps writing the base columns only, dropping grades with a counter, until
the columns exist. Paste that file (or re-run `schema.sql`, which carries the
same block) into the Supabase SQL editor once; the worker re-probes every
five minutes and starts writing grades and exits without a restart.

## Accounts and billing (1.21.0)

The feed can sit behind a gate. `RADAR_ACCESS` picks it:

| mode           | who may read the feed                                   |
| -------------- | ------------------------------------------------------- |
| `open`         | anyone with the URL — the default, unchanged behaviour  |
| `account`      | anyone signed in through Supabase Auth (email code)     |
| `subscription` | signed in AND holding an active Stripe subscription     |

The app's **Account** page reads the gate from the worker's `/config` and
shows exactly what that mode needs: nothing, a sign-in, or a plan with the
price Stripe reports. Sign-in is an email and a six-digit code — no
password anywhere. Payment is Stripe's own hosted page; the worker mints
the Checkout URL and believes Stripe's signed webhooks, and never sees a
card. Routes: `GET /config`, `GET /me`, `POST /billing/checkout`,
`POST /billing/portal`, `POST /billing/webhook`; `/health` stays public and
reports `access` and `billing` counters.

Turn it on in this order; `/health` names the step you are on.

1. **Migration.** Supabase → SQL editor → paste
   [`supabase/migrations/003-accounts.sql`](supabase/migrations/003-accounts.sql)
   → Run. It creates `subscriptions` and closes anon reads on the radar
   tables (the feed is the read path now; with a gate on it, a table anyone
   can read with the public key is the feed with the gate left open).
   `/health` → `db.accounts` says `current`, `db.anon_reads` says `closed`.
2. **Email code.** Supabase → Authentication → Email Templates → *Magic
   Link*: add `{{ .Token }}` to the body (e.g. `Your code: {{ .Token }}`).
   Without it the email carries a link only, which works on the web app
   but not inside the desktop app. Authentication → URL Configuration →
   add `https://romapps.xyz/nova/account/` to Redirect URLs so the link
   path lands on the account page.
3. **Sign-in.** Render → the service → Environment: `SUPABASE_ANON_KEY`
   (Project Settings → API → the anon / publishable key — public by
   design) and `RADAR_ACCESS=account`. Deploy. The Account page now signs
   readers in and the feed refuses connections without a session.
4. **Stripe** (test mode first). Product catalog → add a product with a
   recurring price → copy `price_…`. Developers → API keys → the secret
   key. Developers → Webhooks → add endpoint
   `https://<your-service>.onrender.com/billing/webhook` with events
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted` → copy
   `whsec_…`. Settings → Billing → Customer portal → activate (the Manage
   billing button needs it). Then in Render: `STRIPE_SECRET_KEY`,
   `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `APP_URL=https://romapps.xyz/nova`,
   `RADAR_ACCESS=subscription`. Deploy. `/health` → `billing.price` shows
   what Stripe will charge. Pay once with Stripe's test card
   (4242 4242 4242 4242) and watch `billing.applied` go to 1.
5. **Live.** Swap the three Stripe values for live-mode ones (a second
   webhook endpoint in live mode, with its own secret). Nothing else changes.

A subscription whose period has ended still reads the feed for
`ENTITLEMENT_GRACE_HOURS` (default 24) — renewal webhooks land minutes
after the period rolls, and a paying reader must not lose the feed for the
time Stripe's retries take. Connected sockets are re-checked every ten
minutes; a lapsed one hears `gate` and is closed.

## The HTTP API and referrals (1.22.0)

Everything the socket pushes, as JSON on request, behind the same gate:
[`API.md`](API.md). Readers mint keys on the app's Account page (needs
[`supabase/migrations/004-api-keys.sql`](supabase/migrations/004-api-keys.sql)
once; `/health` → `db.api_keys` says when). `API_RATE_PER_MIN` (60) and
`API_KEYS_PER_USER` (10) are the knobs.

`REFERRAL_GMGN` puts the operator's GMGN referral code on the app's GMGN
handoff links (web and Telegram bot, in the formats GMGN documents). The
app reads it from `/config`, ships no code of its own, and says on the
radar page that the links carry one. Empty means plain links.

## What triggers a deploy

The Blueprint's `buildFilter` deploys on changes under `worker/`, under
`src/lib/radar/engine/` (the shared engine the worker imports), and to
`render.yaml` itself. A commit that touches only the app does not redeploy
the worker, and should not.

## Run locally

```bash
cd worker
npm install
DRY_RUN=1 npm start
```

`DRY_RUN=1` runs the full live pipeline against the real streams with an
in-memory store — no database, no keys. `/health` on port 8790 shows streams,
counts and coverage. With a `.env` (copy `.env.example`), `npm run dry` loads
it.

## Environment

See [`.env.example`](.env.example) — every variable, with defaults. Keys are
pasted by the operator into Render or a local `.env`; they never belong in
chats, commits, or this repository.
