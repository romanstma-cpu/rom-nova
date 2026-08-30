// Runs the desktop RPC-proxy probe under the real Electron binary.
//
// Kept as a launcher rather than folded into probe:wallet because the thing it
// proves can only be proved by Electron: that `protocol.handle` hands a POST
// BODY to its handler, and that a renderer under `sandbox: true` may fetch its
// own app:// origin. Neither is observable from Node.
//
//   npm run probe:desktop-rpc
//
// Needs ../out (npm run build:static) and an installed electron — this repo
// keeps it in desktop/node_modules.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probe = path.join(root, "desktop", "rpc-proxy-probe.js");

// The worktree may have no desktop/node_modules of its own; the checkout above
// it does. Both are tried before giving up with something actionable.
const candidates = [
  path.join(root, "desktop", "node_modules", "electron", "dist", "electron.exe"),
  path.join(root, "desktop", "node_modules", ".bin", "electron"),
  path.join(root, "..", "..", "..", "desktop", "node_modules", "electron", "dist", "electron.exe"),
];

if (!existsSync(path.join(root, "out"))) {
  console.error("out/ is missing — run `npm run build:static` first.");
  process.exit(1);
}

const electron = candidates.find((c) => existsSync(c));
if (!electron) {
  console.error(
    "electron not found. Install it in desktop/ (npm install) and re-run.\nLooked in:\n  " +
      candidates.join("\n  "),
  );
  process.exit(1);
}

const res = spawnSync(electron, [probe], { stdio: "inherit" });
process.exit(res.status ?? 1);
