// Which Solana RPC to ask, and it depends on WHO IS ASKING and WHAT FOR.
//
// This file exists because of one header. `api.mainnet-beta.solana.com` serves
// a wallet's entire trading life and returns 403 to any request carrying an
// `Origin`. Browsers attach Origin to every cross-origin request and offer no
// way to suppress it, so the same endpoint is archival from Node and useless
// from a tab. Hardcoding one endpoint therefore throws away real history in
// the runtimes that could have it — which is exactly what the first version of
// this feature did.
//
// MEASURED, on one quiet years-old address, with the header varied:
//
//   endpoint                     Origin          signatures   reaches back
//   api.mainnet-beta.solana.com  (none)          1000/page    375+ days, still paging
//   api.mainnet-beta.solana.com  app://rom-nova  403          —
//   api.mainnet-beta.solana.com  https://…       403          —
//   solana-rpc.publicnode.com    any             77           2.02 days
//
// THE SECOND SPLIT, WHICH IS LESS OBVIOUS AND MORE IMPORTANT
//
// Deep signatures are not deep DATA. Handed a signature from 3, 10, 30 or 60
// days ago, publicnode returns null for every one — its retention is about two
// days for transaction bodies as well as for the index. mainnet-beta serves
// them all, at any age, and allows exactly TEN `getTransaction` calls before
// refusing:
//
//   mainnet-beta getTransaction, 80 calls, after a 45s cooldown
//     concurrency 3, no pacing    10 ok, 70 refused   1.6 tx/s
//     concurrency 2, 250ms gap    10 ok, 70 refused   0.5 tx/s
//     concurrency 4, 300ms gap    10 ok, 70 refused   0.9 tx/s
//   publicnode, same shape        80 ok,  0 refused   112 tx/s
//
// Ten, whatever the pacing. Reading four hundred transactions through
// mainnet-beta would take minutes, so the FILLS stay inside publicnode's
// two-day window in every runtime, and no amount of cleverness changes that.
//
// What the archival index does buy is the wallet's AGE and its lifetime
// activity VOLUME — cheap, one request for most wallets, and the single most
// misleading thing about the previous version. A thirty-three-minute-old
// wallet and a two-year-old whale both reported "2.0 days" and looked
// identical. They do not any more.

/** Where the code is running, which decides what it may ask for. */
export type RpcRuntime =
  /** Next.js server route, probe scripts, tests. No Origin header is sent. */
  | "node"
  /** The Electron shell, proxying through its main process. See desktop/rpc-proxy.js. */
  | "desktop"
  /** A tab. Origin is unavoidable, so the archive is out of reach. */
  | "browser";

export interface RpcRoute {
  runtime: RpcRuntime;
  /**
   * Bulk `getTransaction`. Always publicnode: 112 tx/s against mainnet-beta's
   * ten-per-window, and its two-day body retention is the real ceiling on
   * every fill-derived number in the app.
   */
  transactions: string;
  /** `getSignaturesForAddress`. Archival wherever no Origin reaches the server. */
  signatures: string;
  /** True when `signatures` reaches past the ~2-day public window. */
  archivalIndex: boolean;
  /** One clause naming what this runtime can and cannot see. */
  note: string;
}

export const MAINNET_BETA = "https://api.mainnet-beta.solana.com";
export const PUBLICNODE = "https://solana-rpc.publicnode.com";

/**
 * The desktop shell's same-origin proxy path.
 *
 * Must match `RPC_PATH` in `desktop/rpc-proxy.js`. A renderer request to its
 * own origin is not cross-origin, so no Origin header is attached and no
 * preflight happens; the main process then forwards it with `net.fetch`, which
 * sends none either. Measured through the real shell under `sandbox: true`:
 * 341 days of signatures, where the same call made directly from the renderer
 * got 403.
 */
export const DESKTOP_RPC_PATH = "/nova/__rpc/solana";

/** Body retention on the transaction endpoint, measured by age bucket. */
export const TX_RETENTION_DAYS = 2;

const BROWSER_ROUTE: RpcRoute = {
  runtime: "browser",
  transactions: PUBLICNODE,
  signatures: PUBLICNODE,
  archivalIndex: false,
  note:
    "browser build — the archival RPC refuses any request carrying an Origin, which a tab " +
    "cannot omit, so both the index and the fills stop at ~2 days",
};

const NODE_ROUTE: RpcRoute = {
  runtime: "node",
  transactions: PUBLICNODE,
  signatures: MAINNET_BETA,
  archivalIndex: true,
  note:
    "server-side — the archival index gives this wallet's real age and lifetime transaction " +
    "count; the fills still come from the fast endpoint's ~2-day window",
};

function desktopRoute(origin: string): RpcRoute {
  return {
    runtime: "desktop",
    transactions: PUBLICNODE,
    signatures: `${origin}${DESKTOP_RPC_PATH}`,
    archivalIndex: true,
    note:
      "desktop shell — RPC forwarded through the main process, which sends no Origin, so the " +
      "archival index is reachable; the fills still come from the fast endpoint's ~2-day window",
  };
}

/**
 * Whether the desktop proxy is actually there.
 *
 * Feature-detected rather than assumed from the `app:` scheme, because the
 * static bundle and the shell auto-update independently: a new page inside an
 * older installer would post into a 404 and lose the wallet feature entirely.
 * A cheap `getHealth` settles it once per session.
 */
async function desktopProxyWorks(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}${DESKTOP_RPC_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    return body.result !== undefined && body.error === undefined;
  } catch {
    return false;
  }
}

let resolved: RpcRoute | null = null;
let inflight: Promise<RpcRoute> | null = null;

/** The route for this runtime. Detected once, then reused. */
export async function resolveRpcRoute(): Promise<RpcRoute> {
  if (resolved) return resolved;
  if (inflight) return inflight;
  inflight = detect().finally(() => {
    inflight = null;
  });
  resolved = await inflight;
  return resolved;
}

async function detect(): Promise<RpcRoute> {
  if (typeof window === "undefined") return NODE_ROUTE;
  const origin = window.location?.origin ?? "";
  if (window.location?.protocol === "app:" && origin) {
    if (await desktopProxyWorks(origin)) return desktopRoute(origin);
    return {
      ...BROWSER_ROUTE,
      runtime: "browser",
      note:
        "desktop shell WITHOUT the RPC proxy (older installer) — falling back to the ~2-day " +
        "public window; updating the app restores the archival index",
    };
  }
  return BROWSER_ROUTE;
}

/** Tests and probes force a runtime; the app must not. */
export function __setRpcRoute(route: RpcRoute | null): void {
  resolved = route;
  inflight = null;
}
