// Solana RPC, forwarded through the main process so it carries no Origin.
//
// WHY THIS EXISTS
//
// api.mainnet-beta.solana.com serves a wallet's WHOLE trading life —
// `getSignaturesForAddress` paged eight times reached 375 days and had not
// stopped — and it answers 403 to any request carrying an Origin header. Every
// other keyless endpoint either refuses the method outright or, in
// publicnode's case, retains about two days.
//
// A renderer cannot win that. Browsers attach Origin to cross-origin requests
// and there is no flag to suppress it, so the web build at romapps.xyz/nova is
// stuck with two days and says so.
//
// The desktop shell is not a browser, though — it has a Node main process. A
// request the renderer makes to its OWN origin is same-origin (no CORS, no
// preflight), `protocol.handle` intercepts it here, and `net.fetch` from the
// main process sends no Origin at all. So the installer gets the archive the
// website cannot reach, over a path that needs no preload script, no IPC
// channel and no relaxation of `sandbox: true`.
//
// SECURITY
//
// The upstream is a fixed allowlist, never a parameter. Taking a URL from the
// renderer would turn the desktop app into an open proxy that reaches the
// user's LAN and cloud metadata endpoints, which is a far worse bug than the
// one this fixes. Method and content type are checked for the same reason.

const { net } = require("electron");

/** The path the renderer posts to. Same origin as the app, so no CORS. */
const RPC_PATH = "/nova/__rpc/solana";

/**
 * Where the proxy is allowed to forward.
 *
 * mainnet-beta leads because reaching it is the entire point. publicnode
 * follows so a mainnet-beta outage degrades to two days of history rather than
 * to no wallet page at all.
 */
const UPSTREAMS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
];

const MAX_BODY_BYTES = 64 * 1024;

/** Whether this request is for the proxy rather than for a static file. */
function isRpcRequest(pathname) {
  return pathname === RPC_PATH;
}

/**
 * Forwards one JSON-RPC call upstream and returns the response verbatim.
 *
 * Verbatim matters: the wallet provider parses `error.code` to tell a rate
 * limit from a real failure, and a proxy that rewrote errors into its own
 * shape would make every refusal look like a dead endpoint.
 */
async function handleRpc(request) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  let body;
  try {
    body = await request.text();
  } catch {
    return new Response(JSON.stringify({ error: "unreadable body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  // A JSON-RPC call is a few hundred bytes. Anything larger is not one, and
  // forwarding it would make this a general-purpose tunnel.
  if (body.length > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "body too large" }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }
  try {
    const parsed = JSON.parse(body);
    if (!parsed || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
      throw new Error("not json-rpc");
    }
  } catch {
    return new Response(JSON.stringify({ error: "not a JSON-RPC 2.0 request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  let lastStatus = 502;
  for (const upstream of UPSTREAMS) {
    try {
      // net.fetch runs in the main process: no Origin header is attached, which
      // is the whole reason this file exists.
      const res = await net.fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!res.ok) {
        lastStatus = res.status;
        // 429 is the caller's own budget and retrying it on another upstream
        // would spend a second one; hand it back so the client backs off.
        if (res.status === 429) {
          return new Response(await res.text(), {
            status: 429,
            headers: { "content-type": "application/json", "x-nova-rpc-upstream": upstream },
          });
        }
        continue;
      }
      return new Response(await res.text(), {
        status: 200,
        headers: {
          "content-type": "application/json",
          // Lets the renderer report which archive answered, so the coverage
          // note can say "375 days available" instead of guessing.
          "x-nova-rpc-upstream": upstream,
        },
      });
    } catch {
      // Try the next upstream. A dead first choice is not a dead feature.
    }
  }
  return new Response(JSON.stringify({ error: "all upstreams unreachable" }), {
    status: lastStatus,
    headers: { "content-type": "application/json" },
  });
}

module.exports = { RPC_PATH, UPSTREAMS, isRpcRequest, handleRpc };
