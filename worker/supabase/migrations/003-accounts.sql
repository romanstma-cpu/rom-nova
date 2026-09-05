-- ROM Nova Radar — 1.21.0, accounts and billing.
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query → paste → Run).
-- Idempotent: safe to re-run. Adds one table, drops four read policies.
--
-- Run it BEFORE setting RADAR_ACCESS to account or subscription. The worker
-- refuses to admit anyone in subscription mode until the table exists, and
-- /health names this file until then.

-- One row per reader who has been through Stripe. Written by the worker
-- (service role) from signed webhooks only; read by the worker's gate.
-- Keyed on the Supabase Auth user id, so a reader who lapses and returns
-- keeps one row and one Stripe customer.
create table if not exists subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  stripe_customer_id text unique,
  stripe_subscription_id text,
  -- Stripe's own words: active, trialing, past_due, canceled, unpaid,
  -- incomplete, incomplete_expired, paused. The gate admits active and
  -- trialing, and past_due inside the grace window after the period end.
  status text not null default 'none',
  price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_customer_idx on subscriptions (stripe_customer_id);

alter table subscriptions enable row level security;
-- A reader may see their own row (the app reads it through the worker's
-- /me today, but the policy is the honest default for a table about them).
do $$ begin
  create policy subscriptions_own_read on subscriptions for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- The radar tables stop being world-readable. The original schema let the
-- anon key SELECT everything because the feed was public anyway; with a
-- gate on the feed, a table anyone can read with the public key is the
-- same feed with the gate left open. The app has never read these tables
-- directly — it reads the worker's feed — so nothing visible changes. The
-- worker's /health reports anon_reads until this has run.
drop policy if exists tracked_wallets_read on tracked_wallets;
drop policy if exists wallet_trades_read on wallet_trades;
drop policy if exists signals_read on signals;
drop policy if exists token_launches_read on token_launches;
