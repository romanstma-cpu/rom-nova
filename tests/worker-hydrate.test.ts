// Boot hydration: which fills a restart replays, and in which direction.
//
// Render restarts free services whenever it likes, so every score the hosted
// radar gates on (signalMinScore 70) is rebuilt by this path. It asked the
// database for `ascending: true` under a 4k cap — the OLDEST 4k — so a wallet
// past the cap was scored on its earliest history and everything it had done
// since was invisible. The app's own ledger has always kept the newest end
// (journal.ts splices from the front). Same engine, opposite evidence.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Timestamps handed to the engine, in the order it received them. */
const applied: number[] = [];

vi.mock("../src/lib/radar/engine/score.js", () => ({
  newWallet: (now: number) => ({ firstSeen: now }),
  applyFill: (_w: unknown, fill: { ts: number }) => {
    applied.push(fill.ts);
  },
  applyFollowGrade: () => {},
}));

import { Db } from "../worker/src/db.js";
import { workerConfig } from "./helpers/worker-config";

const T = 1_788_000_000_000;
const WALLET = "8psNvWTrdNTiVRNzAgsou9kETXNJm2SXZyaKuJraVRtf";
const CAP = 4_000;

type Row = Record<string, unknown>;

/** A PostgREST-shaped builder that actually honours order + limit, as the real one does. */
function fakeClient(wallets: Row[], trades: Map<string, Row[]>, spy: { orders: Array<{ column: string; ascending: boolean }> }) {
  return {
    from(table: string) {
      let wallet = "";
      let column = "";
      let ascending = true;
      let cap = Number.POSITIVE_INFINITY;
      const q = {
        select: () => q,
        eq: (_column: string, value: string) => {
          wallet = value;
          return q;
        },
        order: (col: string, opts: { ascending: boolean }) => {
          column = col;
          ascending = opts.ascending;
          if (table === "wallet_trades") spy.orders.push({ column: col, ascending: opts.ascending });
          return q;
        },
        limit: (n: number) => {
          cap = n;
          return q;
        },
        then: (resolve: (v: { data: Row[]; error: null }) => void) => {
          const source = table === "tracked_wallets" ? wallets : (trades.get(wallet) ?? []);
          const sorted = [...source].sort((a, b) => {
            const av = Date.parse(String(a[column]));
            const bv = Date.parse(String(b[column]));
            return ascending ? av - bv : bv - av;
          });
          resolve({ data: sorted.slice(0, cap), error: null });
        },
      };
      return q;
    },
  };
}

/** n fills a second apart, oldest at T. */
const fillsFrom = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    token_address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    buy_or_sell: i % 2 === 0 ? "buy" : "sell",
    amount_sol: 1,
    price_at_trade: 0.5,
    timestamp: new Date(T + i * 1_000).toISOString(),
  }));

async function hydrateWith(fills: Row[]) {
  const spy = { orders: [] as Array<{ column: string; ascending: boolean }> };
  const db = new Db(workerConfig());
  db.client = fakeClient(
    [{ wallet_address: WALLET, first_seen: new Date(T).toISOString(), last_active: new Date(T).toISOString() }],
    new Map([[WALLET, fills]]),
    spy,
  );
  // The 1.17.0 signal columns are a separate concern; this test is the fills.
  db.migrated = false;
  const state = { tracked: new Map() };
  const result = await db.hydrate(state as never);
  return { spy, state, result };
}

describe("boot hydration replays the fills that still describe the wallet", () => {
  beforeEach(() => {
    applied.length = 0;
  });

  it("asks the database for the newest end, not the oldest", async () => {
    const { spy } = await hydrateWith(fillsFrom(10));
    expect(spy.orders).toEqual([{ column: "timestamp", ascending: false }]);
  });

  it("feeds the engine oldest-first, because applyFill is order-dependent", async () => {
    await hydrateWith(fillsFrom(10));
    expect(applied).toHaveLength(10);
    expect(applied).toEqual([...applied].sort((a, b) => a - b));
    expect(applied[0]).toBe(T);
    expect(applied.at(-1)).toBe(T + 9_000);
  });

  it("keeps the RECENT fills when a wallet runs past the cap", async () => {
    const over = 5;
    const { result } = await hydrateWith(fillsFrom(CAP + over));

    expect(applied).toHaveLength(CAP);
    expect(result.fills).toBe(CAP);
    // Ascending order + the same limit dropped the newest `over` fills and
    // scored the wallet on its first day forever. The dropped end must be the
    // OLD one, and the last fill the engine sees must be the latest there is.
    expect(applied[0]).toBe(T + over * 1_000);
    expect(applied.at(-1)).toBe(T + (CAP + over - 1) * 1_000);
    expect(applied).not.toContain(T);
    expect(applied).toEqual([...applied].sort((a, b) => a - b));
  });

  it("still tracks the wallet it replayed", async () => {
    const { state, result } = await hydrateWith(fillsFrom(3));
    expect(state.tracked.has(WALLET)).toBe(true);
    expect(result.wallets ?? state.tracked.size).toBeTruthy();
  });
});
