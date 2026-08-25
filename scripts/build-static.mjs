// Static-export build for romapps.xyz/nova.
// Middleware is unsupported under `output: "export"`, so it is set aside for
// the duration of the build and always restored.

import { execSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
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
  console.log("\nstatic export written to ./out (basePath /nova)");
} finally {
  if (hadMiddleware) renameSync(mwOff, mw);
}
