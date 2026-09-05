# ROM Nova Radar — HTTP API

Everything the radar pushes over its socket, as JSON on request: recent
signals with their grades and exits, the leaderboard with its intelligence
columns, launches, whale discoveries, tracked-wallet fills, behaviour reads,
and signal history out of the database. One base URL — the worker's — and
one header.

## Authentication

The API sits behind the same gate as the feed (`RADAR_ACCESS`, see the
[README](README.md#accounts-and-billing-1210)):

| mode           | what a request needs                                        |
| -------------- | ----------------------------------------------------------- |
| `open`         | nothing                                                     |
| `account`      | an API key, or a session token                              |
| `subscription` | an API key or session token whose owner is paid up          |

Mint a key on the app's **Account** page (signed in). It is shown once; the
worker stores only its SHA-256. Send it as a Bearer:

```
Authorization: Bearer nova_…
```

A key is judged as its owner: a lapsed subscription stops the key the
minute it would stop the session. Keys are revoked from the same page, and
a revoked key stops within a minute everywhere.

The socket takes the same key: `io(url, { auth: { token: "nova_…" } })`.

## Rate limit

Per key (or per session, or per address on an open radar): `API_RATE_PER_MIN`
requests a minute, default 60, sliding window. Every data response carries
`x-ratelimit-limit` and `x-ratelimit-remaining`; a refusal is `429` with
`retry-after` in seconds.

## Endpoints

All `GET`. `limit` is 50 by default and 200 at most. Every response carries
`as_of`, the worker's clock at the answer.

| path                             | body                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| `/api/v1/signals`                | `signals`: the most recent, newest first, with grades and exits   |
| `/api/v1/signals?since=<ISO>`    | `signals` from the database since that instant (30 days at most)  |
| `/api/v1/wallets`                | `wallets`: the leaderboard by score, with the intelligence columns |
| `/api/v1/wallets/<address>`      | `wallet`: one tracked wallet's row; `signals`: its recent signals |
| `/api/v1/launches`               | `launches`: the creation stream, newest first                     |
| `/api/v1/whales`                 | `whales`: wallets crossing the discovery gate                     |
| `/api/v1/trades`                 | `trades`: journaled fills by tracked wallets                      |
| `/api/v1/behaviours`             | `behaviours`: dormant_buy, accumulation, distribution, wash_like  |
| `/api/v1/model`                  | `card`: the graded model — verdict, folds, weights, norm; `forward`: its record on signals it stamped as they fired |

Rows carry the same fields the socket's events do; a signal's `ret_1m`,
`ret_5m`, `ret_15m`, `ret_1h`, `peak_ret_1h`, `graded_stale`,
`graded_lookup` and `whale_exit_*` are absent (recent ring) or null
(database history) until graded — treat a missing key and a null the same. A wallet's
`labels`, `consistency`, `max_drawdown_sol`, `median_hold_ms`,
`follow_ret_5m`, `follow_hit_rate` and `signals_graded` are the measured
intelligence columns; `unmeasured_sells` says how much of its record the
score does NOT stand on.

Community, on a gated radar only (an open one has no readers to count),
with a session or a key, under the same rate limit:

| method   | path                               | body / result                                                        |
| -------- | ---------------------------------- | -------------------------------------------------------------------- |
| `POST`   | `/api/v1/follows`                  | `{"signal_key": "…"}` → `{signal_key, followers}` — one per reader   |
| `DELETE` | `/api/v1/follows/<signal_key>`     | `{signal_key, followers}`                                            |
| `GET`    | `/api/v1/follows?keys=a,b,c`       | `counts`: followers per key (up to 100)                              |
| `GET`    | `/api/v1/wallets/<address>/notes`  | `notes`: id, handle (a pseudonym), body, created_at, mine            |
| `POST`   | `/api/v1/wallets/<address>/notes`  | `{"body": "…"}` (≤ 280 chars, 3 per reader per wallet, 10 an hour)  |
| `DELETE` | `/api/v1/notes/<id>`               | `{"deleted": id}` — one's own only                                   |

A follow is a count, never a name or an amount; the socket carries
`signal_followers` `{signal_key, followers}` as they change, and signal
rows carry `followers`. A note's `handle` is derived from the reader's id
and cannot be reversed; the operator hides a note by setting `hidden` on
its row.

Key management, with a **session** token (a key may not mint a key):

| method   | path                | body / result                                  |
| -------- | ------------------- | ---------------------------------------------- |
| `GET`    | `/api/keys`         | `keys`: id, prefix, name, created, last used   |
| `POST`   | `/api/keys`         | `{"name": "…"}` → the row plus `key`, once     |
| `DELETE` | `/api/keys/<id>`    | `{"revoked": id}`                              |

A signal may carry `model_p`, the graded model's probability that its
five-minute grade clears +10%, stamped the moment it fired. It is a guess,
not an instruction: `/api/v1/model` says whether the model has any edge on
the fold it never saw, and its `forward` block is the only claim about it
made without hindsight — read that before reading `model_p` as anything.

## Examples

```bash
curl -H "Authorization: Bearer nova_…" \
  "https://rom-nova-radar.onrender.com/api/v1/signals?limit=20"

curl -H "Authorization: Bearer nova_…" \
  "https://rom-nova-radar.onrender.com/api/v1/signals?since=2026-09-05T00:00:00Z&limit=200"
```

```js
import { io } from "socket.io-client";
const s = io("https://rom-nova-radar.onrender.com", { auth: { token: "nova_…" } });
s.on("signal", (sig) => console.log(sig.wallet_score, sig.token_address, sig.buy_amount_sol));
s.on("exit", (e) => e.first && console.log("exit", e.wallet, e.ret));
s.on("connect_error", (err) => console.error(err.message, err.data));
```

## Honesty

The rows are observations from the worker's own stream — pump.fun
bonding-curve trades program-wide, plus off-curve coverage for top wallets
when the operator set a Helius key — and nothing else. Grades are marked to
the last trade seen (`graded_stale`) or to an off-curve quote
(`graded_lookup`) when the stream went quiet. No row is advice, no
endpoint executes anything, and the radar has never held a key to any
wallet.
