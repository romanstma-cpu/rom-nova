-- ROM Nova Radar — 1.22.0, API keys.
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query → paste → Run).
-- Idempotent: safe to re-run. Adds one table.
--
-- One row per key a reader minted on the account page. The key itself is
-- shown once and never stored: key_hash is its SHA-256, and a leaked table
-- opens nothing. Written by the worker (service role); a reader may see
-- their own rows.

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  key_hash text unique not null,
  -- the first characters after "nova_", so a reader can tell two keys apart
  prefix text not null,
  name text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists api_keys_user_idx on api_keys (user_id);

alter table api_keys enable row level security;
do $$ begin
  create policy api_keys_own_read on api_keys for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
