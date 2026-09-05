/* eslint-disable @typescript-eslint/no-require-imports -- Electron main process: CommonJS by nature */
// Does the desktop shell actually reach the archive?
//
// Run with the real Electron binary and the real protocol handler, because the
// two things that can break this are invisible from Node: whether
// `protocol.handle` hands a POST BODY to the handler at all, and whether a
// renderer under `sandbox: true` may fetch its own app:// origin.
//
//   npm run probe:desktop-rpc      (from desktop/)
//
// Prints a verdict and exits. No window is shown.

const { app, BrowserWindow, protocol, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { isRpcRequest, handleRpc, RPC_PATH, UPSTREAMS } = require("./rpc-proxy");

const BASE = "/nova";
const ORIGIN_HOST = "rom-nova";
const staticRoot = path.join(__dirname, "..", "out");
// A quiet, years-old address: publicnode stops at ~2 days on it, so any answer
// deeper than that proves the proxy reached mainnet-beta.
const PROBE_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function resolveStatic(pathname) {
  if (pathname === "/" || pathname === BASE) return path.join(staticRoot, "index.html");
  if (!pathname.startsWith(BASE + "/")) return null;
  const rel = decodeURIComponent(pathname.slice(BASE.length));
  if (rel.includes("..")) return null;
  let file = path.join(staticRoot, rel);
  if (rel.endsWith("/")) file = path.join(file, "index.html");
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  if (fs.existsSync(file + ".html")) return file + ".html";
  return null;
}

const log = (...a) => process.stdout.write(a.join(" ") + "\n");

app.whenReady().then(async () => {
  protocol.handle("app", (request) => {
    const { host, pathname } = new URL(request.url);
    if (host !== ORIGIN_HOST) return new Response("not found", { status: 404 });
    if (isRpcRequest(pathname)) return handleRpc(request);
    const file = resolveStatic(pathname);
    if (!file) return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  log("ROM Nova — desktop RPC proxy probe");
  log(`electron ${process.versions.electron}  ·  upstreams: ${UPSTREAMS.join(", ")}`);
  log(`static root: ${staticRoot} ${fs.existsSync(staticRoot) ? "(present)" : "(MISSING — run npm run build:static first)"}`);

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await win.loadURL(`app://${ORIGIN_HOST}${BASE}/`);

  // Everything below runs in the RENDERER, under sandbox: true, exactly as the
  // shipped app would.
  const script = `(async () => {
    const url = "app://${ORIGIN_HOST}${RPC_PATH}";
    const call = async (method, params) => {
      const t0 = Date.now();
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const upstream = r.headers.get("x-nova-rpc-upstream");
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, ms: Date.now() - t0, upstream, json, raw: text.slice(0, 200) };
    };
    const out = { origin: location.origin, protocol: location.protocol };
    out.health = await call("getHealth", []);
    // Page as deep as the archive allows, to measure real reachable depth.
    let before, total = 0, oldest = null, pages = 0, ms = 0;
    for (let p = 0; p < 6; p++) {
      const res = await call("getSignaturesForAddress", ["${PROBE_ADDRESS}", before ? { limit: 1000, before } : { limit: 1000 }]);
      ms += res.ms;
      if (res.status !== 200 || !res.json || res.json.error) { out.pageError = res.json?.error ?? res.status; break; }
      const rows = res.json.result || [];
      pages++;
      if (!rows.length) break;
      total += rows.length;
      oldest = rows[rows.length - 1].blockTime;
      before = rows[rows.length - 1].signature;
      out.upstream = res.upstream;
      if (rows.length < 1000) break;
    }
    out.signatures = total; out.pages = pages; out.oldest = oldest; out.pagingMs = ms;
    // And the negative control: the same call made DIRECTLY from the renderer,
    // which carries an Origin and must be refused.
    try {
      const direct = await fetch("https://api.mainnet-beta.solana.com", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }),
      });
      out.directStatus = direct.status;
    } catch (e) { out.directStatus = "threw: " + e.message; }
    // Refusals the proxy must make.
    const bad = await fetch(url, { method: "GET" });
    out.getStatus = bad.status;
    const notRpc = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"hello":1}' });
    out.notRpcStatus = notRpc.status;
    return out;
  })()`;

  let result;
  try {
    result = await win.webContents.executeJavaScript(script, true);
  } catch (err) {
    log(`RENDERER THREW: ${err && err.message}`);
    app.exit(1);
    return;
  }

  log("");
  log(`renderer origin       ${result.origin}  (protocol ${result.protocol})`);
  log(`proxy getHealth       HTTP ${result.health.status} in ${result.health.ms}ms  upstream=${result.health.upstream ?? "—"}  ${result.health.raw}`);
  if (result.pageError) log(`paging error          ${JSON.stringify(result.pageError)}`);
  const days = result.oldest ? (Date.now() / 1000 - result.oldest) / 86_400 : 0;
  log(`history reachable     ${result.signatures} signatures over ${result.pages} page(s) in ${result.pagingMs}ms`);
  log(`                      oldest ${result.oldest ? new Date(result.oldest * 1000).toISOString().slice(0, 10) : "—"}  =  ${days.toFixed(1)} DAYS`);
  log(`upstream that served  ${result.upstream ?? "—"}`);
  log("");
  log(`direct renderer call  HTTP ${result.directStatus}   (must be 403 — proves the Origin problem is real)`);
  log(`proxy rejects GET     HTTP ${result.getStatus}   (must be 405)`);
  log(`proxy rejects non-RPC HTTP ${result.notRpcStatus}   (must be 400)`);
  log("");

  const ok =
    result.health.status === 200 &&
    days > 5 &&
    result.getStatus === 405 &&
    result.notRpcStatus === 400;
  log(ok
    ? `VERDICT: the desktop shell reaches ${days.toFixed(0)} days of history where the browser build reaches ~2.`
    : `VERDICT: FAILED — see the lines above.`);
  app.exit(ok ? 0 : 1);
});
