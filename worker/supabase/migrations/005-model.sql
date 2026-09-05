-- ROM Nova Radar — 1.23.0, the graded model.
-- Run once in the Supabase SQL editor (Dashboard → SQL → New query → paste → Run).
-- Idempotent: safe to re-run. Adds columns only; drops nothing.
-- schema.sql carries the same block — running that file instead is fine.
--
-- Two facts known at the moment a signal fires that the model learns from
-- (settled sells behind the wallet's score, minutes since the token's
-- launch), and the model's own guess at that moment, so the grade that
-- lands later judges the guess with no hindsight anywhere in the chain.

alter table signals
  add column if not exists settled_sells integer,
  add column if not exists launch_age_ms bigint,
  add column if not exists model_p decimal,
  add column if not exists model_version text;
