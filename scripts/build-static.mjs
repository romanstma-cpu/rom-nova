// Static-export build for romapps.xyz/nova.
// Middleware is unsupported under `output: "export"`, so it is set aside for
// the duration of the build and always restored.

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mw = path.join(root, "src", "middleware.ts");
const mwOff = path.join(root, "src", "middleware.server-only");

const hadMiddleware = existsSync(mw);
if (hadMiddleware) renameSync(mw, mwOff);
rmSync(path.join(root, ".next"), { recursive: true, force: true });
rmSync(path.join(root, "out"), { recursive: true, force: true });

try {
  execSync("npx next build", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ROMNOVA_STATIC: "1" },
  });
  mirrorPrefetchPayloads(path.join(root, "out"));
  console.log("\nstatic export written to ./out (basePath /nova)");
} finally {
  if (hadMiddleware) renameSync(mwOff, mw);
}

/**
 * Give each route's RSC prefetch payload the name the ROUTER ASKS FOR.
 *
 * The export writes a nested route's payload into a DIRECTORY —
 * `alerts/__next.alerts/__PAGE__.txt` — while the router fetches it as a flat
 * dotted file, `alerts/__next.alerts.__PAGE__.txt`. A Next server routes over
 * that difference; static hosting cannot, so every nested route answered 404
 * to its own prefetch on the deployed site. Measured live on romapps.xyz:
 * /alerts, /status, /legal and /token all 404, while the root — whose payload
 * happens to be flat already — returns 200.
 *
 * Navigation still worked (the router falls back to `__next._tree.txt`, which
 * is served), so this cost round trips and filled the console with 404s rather
 * than breaking anything. Copying, not moving: the directory form is what the
 * export expects to find, and only the extra name is missing.
 */
function mirrorPrefetchPayloads(dir) {
  if (!existsSync(dir)) return;
  let copied = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (!statSync(full).isDirectory()) continue;
      if (entry.startsWith("__next.")) {
        for (const file of readdirSync(full)) {
          const flat = path.join(current, `${entry}.${file}`);
          if (!existsSync(flat)) {
            copyFileSync(path.join(full, file), flat);
            copied++;
          }
        }
      } else {
        walk(full);
      }
    }
  };
  walk(dir);
  if (copied > 0) console.log(`prefetch payloads mirrored to their dotted names: ${copied}`);
}
