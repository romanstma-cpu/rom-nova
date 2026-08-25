# ROM Nova

**Solana on-chain intelligence.** Track sophisticated wallets, detect emerging momentum, understand the risk, and rank
opportunities by measurable evidence — with a 3D network view of the money actually moving.

**Live:** https://romapps.xyz/nova/ — the entire terminal runs in your browser; nothing to install, no account,
and your workspace never leaves your device.

ROM Nova is an analytics and decision-support product. It does not predict the future, it does not guarantee outcomes,
and nothing it displays is investment advice. Every signal answers "why?" with numbers, carries a bear case and
invalidation conditions, and the engine is allowed to answer **NO TRADE**. The full data-honesty statement lives at
`/legal` in the app.

---

## Quick start (zero credentials)

```bash
npm install
npm run dev        # http://localhost:3000  (server mode)
```

With no API keys the app runs on a deterministic synthetic universe: 110 tokens, 30 tracked wallets, ~1,700 historical
trades, live-simulated activity — plus one honest live number, the real SOL price, pulled keylessly from CoinGecko and
Crypto.com Exchange public APIs and cross-checked (median of sources, deviation reported). Simulated data is labeled as
simulated everywhere it appears.

Other commands:

```bash
npm run build         # server-mode production build
npm run start         # serve the server-mode build
npm run build:static  # browser-only export → ./out (the public artifact)
node scripts/serve-static.mjs   # serve ./out at localhost:8788/nova/
npm run test          # vitest — 34 engine/universe tests
npm run typecheck     # tsc --noEmit
npm run lint          # eslint (React compiler rules)
npm run calibrate     # prints score distributions + wallet cohort separation
```

## Two build modes, one codebase

Every API route's logic lives in `src/lib/api/handlers.ts`. In **server mode** the Next.js route files wrap those
handlers (with zod validation, per-IP rate limiting middleware, and security headers). In the **static build**
(`ROMNOVA_STATIC=1`) the route files are excluded, and `src/lib/local.ts` dispatches the same `/api/*` URLs to the
same handlers inside the browser — the engine, simulator, backtester and paper desk all run client-side, and user state
(watchlists, alerts, portfolio, research notes) persists in localStorage, private to the visitor. The public deployment
on romapps.xyz/nova is the static build: no server, no shared state, no secrets to protect.

## What's inside

| Route | What it is |
| --- | --- |
| `/` | Command-center dashboard: KPI strip, highest-conviction signals, live 3D network, whale activity feed, movers, net whale flow |
| `/network` | Full 3D network — 5 scene modes (Whale Universe, Money Flow, Constellation, Whale Clusters, Signal Galaxy), particle trade streams, cluster orbits, risk halos, time machine |
| `/scanner` | Full-screen live discovery scanner: re-ranking rows, rank flashes, pin/freeze/pause |
| `/signals` + `/signal?id=` | Signal terminal with 9 strategy profiles, leaderboards, measured accuracy strip; per-signal factor stack with weights, contributions, risks, bear case, invalidation, outcome grading |
| `/tokens` + `/token?m=` | Meme-coin radar; token intelligence: chart with whale markers, whale flow, holders, top traders (measured PnL), transaction feed, risk radar, security, historical-similarity outcome distribution |
| `/whales` + `/whale?a=` | Wallet intelligence: measured smart-money scores with component breakdown, FIFO PnL, round trips, open positions, behavioral profile, cluster membership |
| `/screener` | Bloomberg-style screener with presets and CSV export |
| `/flow` | Aggregate whale buy/sell flow with smart-money net line |
| `/backtest` | Backtesting lab — signals recomputed at each historical step; anti-lookahead integrity check on every run |
| `/portfolio` | Paper desk — simulated fills with slippage, fees, pool-impact rejection, stops/targets enforced by the live loop |
| `/alerts`, `/watchlists`, `/research` | Alert rules evaluated on the live stream; watchlists; research desk (structured Q&A over the app's own data) + journal with outcome tracking |
| `/status`, `/settings` | Provider health (latency, error rate, fallback chains) and provider configuration guide |

Global: `⌘K / Ctrl+K` command palette, SSE live event stream, restrained event toasts.

## Architecture

```
src/lib/types.ts           domain model — every layer speaks these shapes
src/lib/demo/              deterministic universe generator, store, live simulator
src/lib/engine/            features → signals → risk / similarity / backtest / paper / perf / research
src/lib/providers/         vendor adapters behind interfaces + health + fallback registry
src/app/api/*              21 route handlers (zod-validated where they mutate)
src/components/three/      R3F scene: layout math (pure), nodes, particle field, camera rig, FPS governor
db/schema.sql              the durable Postgres schema live mode persists into
tests/                     34 vitest tests (engine invariants + universe determinism)
```

**The one rule that holds everything together:** every read that feeds the signal engine takes an `asOf` timestamp and
refuses to look past it. The dashboard, the time machine, and the backtester share that code path, so anti-lookahead is
structural, not a discipline. The backtester additionally asserts it per entry and fails the run loudly if violated.

### Signal methodology

A signal is a weighted sum of 11 normalized evidence factors (smart-money accumulation, whale flow, momentum, volume
acceleration, liquidity quality, holder growth, distribution, organic activity, age/discovery, market structure,
social attention) minus 4 risk penalties (insider, bundler/sniper, dev activity, exit liquidity), adjusted by market
regime, with a contrast stretch calibrated against the measured score distribution (`npm run calibrate`). Each of the 9
strategy profiles supplies its own weights — mean reversion literally inverts the momentum factor.

Confidence is computed separately from score (sample size, input staleness, token maturity, liquidity) and gates
labels: low confidence, thin liquidity, stacked high-severity risks, or insufficient sample ⇒ **NO TRADE**, whatever
the score says. Every signal stores its exact feature snapshot and engine version, so any historical score is
reproducible bit-for-bit from its id (`sig-<mint8>-<bucket>-<profile>`), and old signals are graded against what
actually happened next (`/api/accuracy`).

Smart-money scores are **measured, not asserted**: FIFO replay of each wallet's trades → win rate, profit factor,
drawdown, consistency (a single lucky trade cannot mint a high score — tested), damped by data confidence.

### Data providers

| Provider | Key | Role |
| --- | --- | --- |
| Jupiter Tokens V2 / Swap V2 | `JUPITER_API_KEY` (or lite tier) | token info, verification, organic score. Ultra API is superseded and not used |
| Birdeye | `BIRDEYE_API_KEY` | OHLCV, token security, holder positions & labels (smart_trader/insider/dev/sniper/bundler) |
| Helius | `HELIUS_API_KEY` | enhanced wallet transactions, webhooks, RPC/WS |
| Nansen | `NANSEN_API_KEY` | optional premium wallet labels |
| DEX Screener | keyless (`ENABLE_DEXSCREENER`) | market-data fallback |
| CoinGecko | keyless (`COINGECKO_API_KEY` optional) | live SOL reference + global context — **on by default** |
| Crypto.com Exchange | keyless | live SOL_USD ticker — **on by default** |
| InfStones | `INFSTONES_API_KEY` | third-opinion price cross-check |

Fallback chains and per-provider health (mode, latency, error rate, last data) are visible at `/status`. Switching demo
→ live is configuration: copy `.env.example` → `.env.local`, add keys, restart. Adapters normalize into the domain
types; no page knows a vendor payload shape.

### Demo universe

One seed (`ROMNOVA_DEMO_SEED`, default 77) generates the whole world: token archetypes (moonshots, rugs, grinders,
choppers, faders, sleepers, fresh launches) with bounded lifetime multiples, liquidity/holder curves, wallet cohorts
whose trades are sampled by skill (skilled wallets buy dips and sell peaks; unskilled chase and capitulate — so the
measured smart-money scores separate cohorts honestly), and three coordinated clusters with evidence. Same seed, same
world, same screenshots. The simulator continues every price path in real time and feeds the SSE stream.

## Security posture

- API keys live server-side in environment variables and never reach the browser.
- No private keys, no seed phrases, no paste-a-key flows — anywhere, ever.
- Live trading is **not implemented**. The design reserves `ENABLE_REAL_TRADING` for a wallet-adapter signature flow
  with explicit per-trade confirmation; this build ships without it, hard off.
- Paper trading is clearly labeled simulated; fills model slippage, fees and pool impact, and oversized orders reject.
- Mutating API routes validate bodies with zod. Ingestion is idempotent by design (`ingestion_events.dedup_key`).

## Deployment

Standard Next.js app: `npm run build && npm run start` behind any Node host, or Vercel. For live mode also provision
Postgres (`db/schema.sql`, Supabase-compatible) and optionally Redis for hot caches; demo mode needs neither. Set
`NEXT_PUBLIC_APP_URL` and provider keys per `.env.example`.

## Honesty notes

The demo universe is synthetic. Backtest results, accuracy stats and wallet PnL in demo mode measure the engine against
that synthetic world — they demonstrate the *method* (explainability, anti-lookahead, outcome grading), not real-market
performance. The app labels demo data as demo in the UI, the APIs (`demo: true`), and this README, and it will keep
doing so in your screenshots.
