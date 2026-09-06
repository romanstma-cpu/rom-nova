# Leaving ROM Nova alone

Written 2026-09-06, at 1.28.0. Everything below was measured that day, not
remembered. `progress.md` is the build log; this is the operations note.

## What is running

| | where | state |
|---|---|---|
| Site + browser app | romapps.xyz/nova/ | 1.28.0, GitHub Pages |
| Desktop app | `ROM-Nova-Setup.exe` | 1.28.0, installer `b4e9beef…c714` |
| Update feed | `releases/latest/download/latest.yml` | 200, `version: 1.28.0` |
| Hosted radar | rom-nova-radar.onrender.com | streaming, Supabase `current` |

Local gate at the time of writing: typecheck clean, lint clean, 956 tests
passing, working tree clean.

## The sixty-second check when you come back

```bash
curl -s -o /dev/null -w "feed %{http_code}\n" -L https://github.com/romanstma-cpu/rom-nova/releases/latest/download/latest.yml
curl -s -o /dev/null -w "app  %{http_code}\n" https://romapps.xyz/nova/
curl -s https://rom-nova-radar.onrender.com/health | head -c 400
```

In `/health`, the fields that actually tell you something:

- `db.lastError` — `null` is good. Anything about size or read-only means the
  database filled up; see **Storage** below.
- `db.queued` and `db.dropped` — a queue that climbs and never drains, or
  drops above zero, means writes are failing.
- `streams.*.connected` — all three should be `true`. `lastError` is a
  historical record, not a live state; a socket reconnects and keeps the last
  error it ever saw. Judge by `connected` and `lastFrameAgoMs`.
- `model.verdict` — `"no edge"` is an honest answer, not a fault. The model is
  built to be able to say it, and it is currently saying it.

## What needs a human

Nothing here does itself, and nothing else in the system is waiting on it.

**1. One DNS field, for sign-in email.**
Two of the three Resend records are exactly right:

- `send.romapps.xyz` TXT → `v=spf1 include:amazonses.com ~all` ✓
- `resend._domainkey.romapps.xyz` TXT → the `p=…` key ✓
- `send.romapps.xyz` MX → `inbound-smtp.us-east-1.amazonaws.com` ✗

Resend's own documentation gives the outbound value as
`feedback-smtp.us-east-1.amazonses.com` and says `inbound-smtp…` is for
receiving mail only. Change that one Answer field at Porkbun, keep priority
10, then press Verify in Resend. Do not touch the `romapps.xyz` A records
(185.199.108–111.153) or the `www` CNAME — those are the site.

Until that verifies, Supabase cannot send a sign-in email, which is why:

**2. The hosted radar currently admits nobody.**
`RADAR_ACCESS=account` with sign-in email dead means `/health` reads
`access.allowed: 0` against `unauthenticated: 8`. Two ways out, both yours:
finish the DNS above, or set `RADAR_ACCESS=open` in the Render dashboard while
you are away.

This affects only the *hosted* 24/7 radar. The in-app radar is keyless and
runs in the reader's own browser — the app works fully for everyone right now.

**3. Measure the database before it decides for you.** See below.

**4. Code signing.** Deferred by you, still deferred. Updates are fetched over
TLS and checked against the sha512 in `latest.yml`, so they are not
unverified — but there is no Authenticode signature, and Windows will keep
warning on install until there is one.

## What rots on its own

**Storage — the one that actually stops it.** The worker has no retention and
never has. It wrote 628,502 `wallet_trades` rows in 29 hours, about six a
second, and nothing in the system reports the database's size or warns as it
fills. Supabase's free tier goes read-only at 500 MB; the worker would keep
streaming and counting dropped writes while nothing persisted.

Measure first — the query is STEP 0 of
[`worker/supabase/migrations/007-retention.sql`](worker/supabase/migrations/007-retention.sql).
That file also holds a provably lossless prune, an age-based one with its cost
stated, and an optional nightly `pg_cron` schedule. Every statement in it is
commented out; it is a decision, not a migration.

**Render restarts.** Free services restart whenever Render likes. That is
handled: the worker rebuilds every score from the journal on boot. It replays
the newest 4,000 fills of the 200 most recently active wallets — as of
2026-09-06, because until then it replayed the *oldest* 4,000 and scored
wallets on history that had stopped being true.

**Upstream drift.** pump.fun's program logs, PumpPortal, Jupiter and
DexScreener are all keyless and can change without notice. The radar goes
quiet rather than wrong if they do, and `/health` shows which stream stopped.

**Pinned CI actions.** `.github/workflows/release.yml` still pins
`actions/checkout@v4` and `actions/setup-node@v4`. Both run with a deprecation
warning; v7 is current and setup-node v7 moved to ESM. Untestable without
burning a tag, so it was left alone deliberately.

## What is safe to ignore

- **`model.verdict: "no edge"`** — the model is reporting honestly on its own
  forward record. Nothing in this app has ever measured profitable, and the
  app says so on every screen that could be mistaken for a recommendation.
- **`dexscreener.failures` climbing slowly** — that path now shares a backoff
  with the price lookup and reports its cause. Failures that self-limit are
  the system working.
- **`SIMULATED` labels everywhere** — deliberate. Live and simulated data sit
  side by side by design, and every simulated number is labelled where it is
  shown.

## The release drill, if you ship again

Feature commit → bump `desktop/package.json` → `npm run build:static` (after
the bump, not before) → bump commit → `git tag vX.Y.Z` → push → watch the run
→ verify sha256 against `SHA256SUMS.txt` and GitHub's digest → mirror `out/`
into `rom-site/nova` → edit the four version anchors in `rom-site/index.html`
with an editor, never PowerShell → push → wait for Pages → install and prove
the desktop app writes to `C:\Users\W\AppData\Roaming\ROM Nova`.

The workflow now creates the GitHub release *before* electron-builder runs and
asserts all three assets exist afterwards. Both exist because 1.27.1 and
1.28.0 shipped with no update feed at all: electron-builder 26 runs its
publishers concurrently, both raced to create the release, and the loser's 422
killed the step after the installer uploaded and before `latest.yml` did.
Do not remove either step.
