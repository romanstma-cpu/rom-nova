-- ROM Nova Radar — 1.17.0, the copy desk.
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query → paste → Run).
-- Idempotent: safe to re-run. Adds columns only; drops nothing.
--
-- What the worker writes into these: every signal's grade — the token's
-- price at the first trade one, five, fifteen and sixty minutes after the
-- signal, against the signal's own fill price — plus the signal wallet's
-- first sell afterwards (the exit), and per wallet the medians a copier
-- cares about: how long it holds, and what following its signals paid.

alter table tracked_wallets
  add column if not exists median_hold_ms bigint,
  add column if not exists follow_ret_5m decimal,
  add column if not exists follow_hit_rate decimal,
  add column if not exists signals_graded integer not null default 0;

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

-- One row per signal: the worker upserts on this key, so a restart that
-- replays the same fill cannot write the signal twice. Rows from before
-- this migration keep a null key, which the unique index allows.
create unique index if not exists signals_key_idx on signals (signal_key);
create index if not exists signals_wallet_ts_idx on signals (wallet_address, timestamp desc);
