-- WHALENOVA PostgreSQL schema.
-- Demo mode runs from an in-memory deterministic store; this schema is the
-- durable shape live mode persists into (Supabase-compatible). Types mirror
-- src/lib/types.ts one-to-one so ingestion is a mapping, not a translation.

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- tokens

create table if not exists tokens (
  mint                     text primary key,
  name                     text not null,
  symbol                   text not null,
  created_at               timestamptz not null,
  decimals                 int  not null default 9,
  narrative                text,
  verified                 boolean not null default false,
  mint_authority_revoked   boolean,
  freeze_authority_revoked boolean,
  permanent_delegate       boolean,
  dev_wallet               text,
  first_seen               timestamptz not null default now()
);

create table if not exists token_snapshots (
  id               bigint generated always as identity primary key,
  mint             text not null references tokens(mint),
  ts               timestamptz not null,
  price_usd        double precision not null,
  market_cap_usd   double precision,
  fdv_usd          double precision,
  liquidity_usd    double precision,
  volume_24h_usd   double precision,
  buys_1h          int,
  sells_1h         int,
  unique_buyers_1h int,
  unique_sellers_1h int,
  holders          int,
  top10_pct        double precision,
  dev_holds_pct    double precision,
  organic_score    double precision,
  social_score     double precision,
  bundler_pct      double precision,
  sniper_pct       double precision,
  insider_pct      double precision,
  provider         text not null,
  unique (mint, ts)
);
create index if not exists token_snapshots_mint_ts on token_snapshots (mint, ts desc);

create table if not exists token_prices (
  mint text not null references tokens(mint),
  t    timestamptz not null,
  o double precision, h double precision, l double precision, c double precision,
  v double precision,
  primary key (mint, t)
);

create table if not exists token_security (
  mint        text primary key references tokens(mint),
  checked_at  timestamptz not null,
  warnings    jsonb not null default '[]',
  raw         jsonb
);

create table if not exists token_holder_snapshots (
  mint    text not null references tokens(mint),
  ts      timestamptz not null,
  holders int not null,
  top10_pct double precision,
  primary key (mint, ts)
);

create table if not exists liquidity_pools (
  pool_id   text primary key,
  mint      text not null references tokens(mint),
  dex       text not null,
  base_mint text,
  created_at timestamptz
);

create table if not exists liquidity_events (
  id       bigint generated always as identity primary key,
  mint     text not null references tokens(mint),
  ts       timestamptz not null,
  kind     text not null check (kind in ('add','remove')),
  usd      double precision not null,
  signature text unique
);
create index if not exists liquidity_events_mint_ts on liquidity_events (mint, ts desc);

-- ---------------------------------------------------------------- wallets

create table if not exists wallets (
  address        text primary key,
  display_name   text,
  known_entity   text,
  funding_source text,
  first_seen     timestamptz,
  last_active    timestamptz,
  sol_balance    double precision,
  behavior       jsonb,
  smart_money    jsonb          -- { total, performance, timing, ... }
);

create table if not exists wallet_labels (
  address  text not null references wallets(address),
  label    text not null,
  source   text not null,       -- birdeye | nansen | internal
  added_at timestamptz not null default now(),
  primary key (address, label, source)
);

create table if not exists wallet_trades (
  id             text primary key,      -- deterministic dedup key
  signature      text not null,
  address        text not null references wallets(address),
  mint           text not null references tokens(mint),
  ts             timestamptz not null,
  side           text not null check (side in ('buy','sell')),
  amount_usd     double precision not null,
  amount_tokens  double precision not null,
  price_usd      double precision not null,
  dex            text,
  classification text check (classification in ('open','add','reduce','exit','rotate','transfer','lp','unknown')),
  confidence     double precision,
  unique (signature, address, mint)     -- one event per tx per wallet per mint
);
create index if not exists wallet_trades_addr_ts on wallet_trades (address, ts desc);
create index if not exists wallet_trades_mint_ts on wallet_trades (mint, ts desc);

create table if not exists wallet_positions (
  address        text not null references wallets(address),
  mint           text not null references tokens(mint),
  tokens         double precision not null,
  cost_basis_usd double precision not null,
  opened_at      timestamptz,
  last_changed_at timestamptz,
  primary key (address, mint)
);

create table if not exists wallet_performance_snapshots (
  address text not null references wallets(address),
  ts      timestamptz not null,
  perf    jsonb not null,        -- WalletPerformance
  primary key (address, ts)
);

create table if not exists wallet_clusters (
  id           text primary key,
  name         text not null,
  entry_lag_sec int,
  cohesion     double precision,
  detected_at  timestamptz not null,
  evidence     jsonb not null default '[]'
);

create table if not exists wallet_cluster_members (
  cluster_id text not null references wallet_clusters(id),
  address    text not null references wallets(address),
  primary key (cluster_id, address)
);

-- ---------------------------------------------------------------- signals

create table if not exists signals (
  id             text primary key,      -- sig-<mint8>-<bucket>-<profile>
  mint           text not null references tokens(mint),
  kind           text not null,
  profile        text not null,
  created_at     timestamptz not null,
  updated_at     timestamptz not null,
  score          int not null check (score between 0 and 100),
  confidence     double precision not null,
  label          text not null,
  engine_version text not null,
  feature_schema_version text not null default '1',
  features       jsonb not null,        -- exact FeatureVector snapshot (reproducibility)
  risks          jsonb not null default '[]',
  invalidation   jsonb not null default '[]',
  bear_case      jsonb not null default '[]',
  why            jsonb not null default '[]'
);
create index if not exists signals_mint on signals (mint, created_at desc);
create index if not exists signals_score on signals (score desc, created_at desc);

create table if not exists signal_factors (
  signal_id    text not null references signals(id),
  key          text not null,
  name         text not null,
  raw          double precision,
  normalized   double precision,
  weight       double precision,
  contribution double precision,
  explanation  text,
  primary key (signal_id, key)
);

create table if not exists signal_events (
  id        bigint generated always as identity primary key,
  signal_id text not null references signals(id),
  state     text not null check (state in ('created','confirmed','strengthened','weakened','invalidated','triggered','expired')),
  ts        timestamptz not null,
  note      text
);

create table if not exists signal_outcomes (
  signal_id     text primary key references signals(id),
  evaluated_at  timestamptz not null,
  return_1h     double precision,
  return_24h    double precision,
  max_favorable double precision,
  max_adverse   double precision,
  hit           boolean
);

-- ---------------------------------------------------------------- user state

create table if not exists watchlists (
  id         text primary key,
  user_id    uuid references users(id),
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists watchlist_items (
  watchlist_id text not null references watchlists(id),
  kind         text not null check (kind in ('token','wallet')),
  ref          text not null,
  added_at     timestamptz not null default now(),
  note         text,
  primary key (watchlist_id, ref)
);

create table if not exists alert_rules (
  id         text primary key,
  user_id    uuid references users(id),
  name       text not null,
  condition  jsonb not null,
  channels   jsonb not null default '["in_app"]',
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists alert_events (
  id       text primary key,
  rule_id  text not null references alert_rules(id),
  ts       timestamptz not null,
  headline text not null,
  detail   text,
  mint     text,
  wallet   text,
  read     boolean not null default false
);
create index if not exists alert_events_ts on alert_events (ts desc);

-- ---------------------------------------------------------------- paper

create table if not exists paper_portfolios (
  id           text primary key,
  user_id      uuid references users(id),
  name         text not null,
  created_at   timestamptz not null default now(),
  starting_usd double precision not null,
  cash_usd     double precision not null,
  realized_pnl_usd double precision not null default 0
);

create table if not exists paper_positions (
  portfolio_id   text not null references paper_portfolios(id),
  mint           text not null,
  tokens         double precision not null,
  cost_basis_usd double precision not null,
  opened_at      timestamptz,
  stop_loss_pct  double precision,
  take_profit_pct double precision,
  primary key (portfolio_id, mint)
);

create table if not exists paper_orders (
  id            text primary key,
  portfolio_id  text not null references paper_portfolios(id),
  mint          text not null,
  side          text not null check (side in ('buy','sell')),
  requested_usd double precision not null,
  ts            timestamptz not null,
  status        text not null check (status in ('filled','rejected')),
  reject_reason text
);

create table if not exists paper_fills (
  order_id        text primary key references paper_orders(id),
  ts              timestamptz not null,
  price_usd       double precision not null,
  tokens          double precision not null,
  usd             double precision not null,
  fee_usd         double precision not null,
  slippage_pct    double precision not null,
  price_impact_pct double precision not null
);

-- ---------------------------------------------------------------- backtests

create table if not exists backtests (
  id       text primary key,
  user_id  uuid references users(id),
  ran_at   timestamptz not null,
  config   jsonb not null,
  result   jsonb not null,       -- summary metrics + integrity block
  engine_version text not null
);

create table if not exists backtest_trades (
  backtest_id text not null references backtests(id),
  seq         int not null,
  mint        text not null,
  entry_ts    timestamptz not null,
  exit_ts     timestamptz not null,
  entry_price double precision,
  exit_price  double precision,
  exit_reason text,
  pnl_usd     double precision,
  primary key (backtest_id, seq)
);

-- ---------------------------------------------------------------- system

create table if not exists market_regimes (
  ts     timestamptz primary key,
  regime text not null,
  confidence double precision,
  features jsonb
);

create table if not exists narratives (
  id   text primary key,
  name text not null
);

create table if not exists token_narratives (
  mint         text not null references tokens(mint),
  narrative_id text not null references narratives(id),
  momentum     double precision,
  primary key (mint, narrative_id)
);

create table if not exists social_events (
  id     bigint generated always as identity primary key,
  mint   text references tokens(mint),
  ts     timestamptz not null,
  source text not null,
  kind   text not null,          -- mention | trend | paid | bot_suspect
  weight double precision
);
create index if not exists social_events_mint_ts on social_events (mint, ts desc);

create table if not exists data_provider_health (
  provider text not null,
  ts       timestamptz not null,
  status   text not null,
  latency_ms int,
  error_rate_pct double precision,
  primary key (provider, ts)
);

create table if not exists ingestion_events (
  dedup_key text primary key,    -- signature:wallet:mint — replays are no-ops
  provider  text not null,
  ts        timestamptz not null default now(),
  payload   jsonb
);

create table if not exists system_events (
  id   bigint generated always as identity primary key,
  ts   timestamptz not null default now(),
  kind text not null,
  detail jsonb
);
