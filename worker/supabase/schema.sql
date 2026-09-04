-- ROM Nova Radar — Supabase schema.
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query → paste → Run).
-- Idempotent: every statement is IF NOT EXISTS / OR REPLACE-safe to re-run.
--
-- Write path: ONLY the worker's service-role key writes (service role
-- bypasses RLS). Read path: the anon key may SELECT everything — these are
-- public market observations, and the frontend never needs a write.

create extension if not exists pgcrypto;

-- Wallets the scanner discovered and follows. Scores are recomputed by the
-- worker after every observed fill and upserted here.
create table if not exists tracked_wallets (
  id uuid primary key default gen_random_uuid(),
  wallet_address text unique not null,
  score integer not null default 0,
  win_rate decimal not null default 0,
  total_trades integer not null default 0,
  realized_pnl decimal not null default 0,
  -- Beyond the base columns: the honesty fields. avg_roi is the mean return
  -- per settled sell; settled_sells counts sells with a fully-observed cost
  -- basis; unmeasured_sells counts sells the worker refused to score because
  -- it never saw the buys behind them. A reader can always tell how much of
  -- a wallet's record the score actually stands on.
  avg_roi decimal not null default 0,
  settled_sells integer not null default 0,
  unmeasured_sells integer not null default 0,
  first_seen timestamptz not null default now(),
  last_active timestamptz not null default now()
);
create index if not exists tracked_wallets_score_idx on tracked_wallets (score desc);
create index if not exists tracked_wallets_last_active_idx on tracked_wallets (last_active desc);

-- Every observed fill by a tracked wallet. The journal the scores replay from.
create table if not exists wallet_trades (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  token_address text not null,
  buy_or_sell text not null check (buy_or_sell in ('buy', 'sell')),
  amount_sol decimal not null,
  -- SOL per token at this fill (both streams price in SOL; USD context is
  -- looked up at display time, not baked into the record).
  price_at_trade decimal not null,
  timestamp timestamptz not null,
  -- The transaction signature — both streams carry one; nullable only so an
  -- upstream that someday omits it degrades to an undeduped row, not a lost one.
  signature text,
  venue text not null default 'pumpfun'
);
-- The dedupe the two overlapping streams need: one row per (tx, wallet,
-- token, side). The worker also dedupes in memory with the same key.
create unique index if not exists wallet_trades_fill_idx
  on wallet_trades (signature, wallet_address, token_address, buy_or_sell);
create index if not exists wallet_trades_wallet_ts_idx on wallet_trades (wallet_address, timestamp);
create index if not exists wallet_trades_token_idx on wallet_trades (token_address);

-- A proven wallet (score above the gate) buying. What the feed pushes.
create table if not exists signals (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  wallet_score integer not null,
  token_address text not null,
  token_name text,
  buy_amount_sol decimal not null,
  timestamp timestamptz not null
);
create index if not exists signals_ts_idx on signals (timestamp desc);

-- Every launch the creation stream pushed. launch_time is the worker's
-- RECEIPT clock — the creation frame carries no timestamp of its own.
create table if not exists token_launches (
  id uuid primary key default gen_random_uuid(),
  token_address text unique not null,
  token_name text,
  launch_time timestamptz not null,
  -- Virtual SOL in the bonding curve at first sight, when the frame carried
  -- it; null means the frame did not say, never a guessed zero.
  initial_liquidity decimal
);
create index if not exists token_launches_time_idx on token_launches (launch_time desc);

-- 1.17.0, the copy desk: grades and exits on signals, copyability on
-- wallets. Kept as ALTERs so re-running this file upgrades a database made
-- from the earlier version; migrations/002-copy-desk.sql is the same block.
alter table tracked_wallets
  add column if not exists median_hold_ms bigint,
  add column if not exists follow_ret_5m decimal,
  add column if not exists follow_hit_rate decimal,
  add column if not exists signals_graded integer not null default 0,
  -- 1.19.0 wallet intelligence: labels earned from fills, consistency
  -- (mean over spread of per-trade ROI), deepest realized drawdown, mean hold.
  add column if not exists labels text[] not null default '{}',
  add column if not exists consistency decimal,
  add column if not exists max_drawdown_sol decimal not null default 0,
  add column if not exists avg_hold_ms bigint;
alter table signals
  add column if not exists signal_key text,
  add column if not exists price_at_signal decimal,
  add column if not exists ret_1m decimal,
  add column if not exists ret_5m decimal,
  add column if not exists ret_15m decimal,
  add column if not exists ret_1h decimal,
  add column if not exists peak_ret_1h decimal,
  add column if not exists graded_stale boolean not null default false,
  add column if not exists graded_lookup boolean not null default false,
  add column if not exists whale_exit_ret decimal,
  add column if not exists whale_exit_after_ms bigint,
  add column if not exists whale_exit_fraction decimal;
create unique index if not exists signals_key_idx on signals (signal_key);
create index if not exists signals_wallet_ts_idx on signals (wallet_address, timestamp desc);

-- RLS: anon reads, nobody but the service role writes.
alter table tracked_wallets enable row level security;
alter table wallet_trades enable row level security;
alter table signals enable row level security;
alter table token_launches enable row level security;

do $$ begin
  create policy tracked_wallets_read on tracked_wallets for select using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy wallet_trades_read on wallet_trades for select using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy signals_read on signals for select using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy token_launches_read on token_launches for select using (true);
exception when duplicate_object then null; end $$;
