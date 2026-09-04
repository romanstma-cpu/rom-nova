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
