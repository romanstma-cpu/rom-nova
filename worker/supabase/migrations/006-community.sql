-- ROM Nova Radar — 1.24.0, community.
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query → paste → Run).
-- Idempotent: safe to re-run. Adds two tables. schema.sql carries the same block.
--
-- follows: a reader saying "I followed this signal" — a count on the
-- signal for every other reader, never a name. notes: a reader's short
-- note on a tracked wallet, shown to signed-in readers under a stable
-- pseudonym derived from their id; the operator can hide one by setting
-- hidden = true in the table. Written by the worker (service role) on the
-- reader's behalf; a reader may see their own rows.

create table if not exists follows (
  user_id uuid not null references auth.users (id) on delete cascade,
  signal_key text not null,
  at timestamptz not null default now(),
  primary key (user_id, signal_key)
);
create index if not exists follows_signal_idx on follows (signal_key);
alter table follows enable row level security;
do $$ begin
  create policy follows_own_read on follows for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  wallet_address text not null,
  body text not null check (char_length(body) between 1 and 280),
  created_at timestamptz not null default now(),
  hidden boolean not null default false
);
create index if not exists notes_wallet_idx on notes (wallet_address, created_at desc);
alter table notes enable row level security;
do $$ begin
  create policy notes_own_read on notes for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
