// Local stand-in for GitHub Pages: serves ./out under the /nova base
// path on :8788, exactly how romapps.xyz/nova will serve it.

import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "out");
// Overridable because several worktrees of this repo get served at once, and
// the second one to start does not fail loudly — it EADDRINUSEs while a browser
// pointed at the port happily renders the OTHER worktree's build, which looks
// exactly like your changes not having taken effect. Two separate reviews hit
// this. `PORT=8797 node scripts/serve-static.mjs`.
const PORT = Number(process.env.PORT) || 8788;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let p = decodeURIComponent(url.pathname);
    if (p === "/" || p === "/nova") {
      res.writeHead(302, { Location: "/nova/" });
      return res.end();
    }
    if (!p.startsWith("/nova/")) {
      res.writeHead(404);
      return res.end("not found (site root is /nova/)");
    }
    p = p.slice("/nova".length);
    let file = path.join(root, p);

    // A slashless path that names a real directory REDIRECTS, as Pages does.
    //
    // This build sets `trailingSlash`, so every internal link is already
    // slashed and production 301s anything that is not. The harness did neither:
    // `/nova/scanner` resolved to a directory that exists, so the `.html`
    // fallback below never fired and the `isFile()` check then 404'd it. The
    // page a reviewer typed by hand was the one page the local server refused,
    // which cost two separate reviews time before anyone traced it.
    //
    // Redirecting rather than quietly serving the index matters: relative asset
    // URLs resolve against a different base without the slash, so serving it
    // directly would work here and break on Pages — a harness that diverges from
    // production in the direction of being more forgiving is worse than one that
    // 404s, because it hides the failure until deploy.
    if (!p.endsWith("/") && existsSync(file) && statSync(file).isDirectory()) {
      res.writeHead(301, { Location: `/nova${p}/${url.search}` });
      return res.end();
    }

    if (p.endsWith("/")) file = path.join(file, "index.html");
    if (!existsSync(file) && existsSync(file + ".html")) file += ".html";
    if (!existsSync(file) || !statSync(file).isFile()) {
      const notFound = path.join(root, "404.html");
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      if (existsSync(notFound)) return createReadStream(notFound).pipe(res);
      return res.end("404");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log(`serving ./out at http://localhost:${PORT}/nova/`));
