// The desktop shell must ship every file it requires.
//
// main.js gained `require("./rpc-proxy")` and electron-builder's `files` list
// did not gain "rpc-proxy.js". The packaged app then threw MODULE_NOT_FOUND
// at load — before `app.whenReady()` could register a window, and before the
// auto-updater could start. Result: a main process that stays alive with two
// Electron helpers, no visible window, nothing written to storage, and NO WAY
// TO UPDATE ITSELF OUT OF IT. Every release from the one that introduced the
// file to 1.7.0 shipped that way, while the web build the reviews exercised
// was fine — the two share a static export and nothing else.
//
// Nobody launched the installer. This test reads the requires the way Node
// will, and reads the bundle list the way electron-builder will, and refuses
// to let them disagree.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const desktop = new URL("../desktop/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Local `require("./x")` targets of one file, resolved to filenames. */
function localRequires(file: string): string[] {
  const src = readFileSync(path.join(desktop, file), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/require\(\s*["']\.\/([^"']+)["']\s*\)/g)) {
    const name = m[1];
    out.push(/\.[cm]?js$/.test(name) ? name : `${name}.js`);
  }
  return out;
}

/** Everything main.js reaches through local requires, transitively. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (existsSync(path.join(desktop, f))) for (const r of localRequires(f)) stack.push(r);
  }
  return [...seen];
}

/** electron-builder `files` entries are globs; these are literal, so match literally, with `*` allowed. */
function bundled(pattern: string, file: string): boolean {
  if (!pattern.includes("*")) return pattern === file;
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(file);
}

describe("desktop bundle ships everything main.js requires", () => {
  const pkg = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8"));
  const files: string[] = pkg.build?.files ?? [];
  const entry: string = pkg.main ?? "main.js";

  it("lists every transitively required local module in build.files", () => {
    const needed = reachable(entry);
    expect(needed.length).toBeGreaterThan(1); // main.js plus at least rpc-proxy.js
    const missing = needed.filter((f) => !files.some((p) => bundled(p, f)));
    expect(missing, `required by ${entry} but absent from build.files — the packaged app will throw at load`).toEqual([]);
  });

  it("only lists modules that exist", () => {
    // A `files` entry for a file that is not there is a different lie — the
    // list would look complete while the build silently skipped it.
    const literal = files.filter((p) => !p.includes("*") && /\.js$/.test(p));
    const ghosts = literal.filter((f) => !existsSync(path.join(desktop, f)));
    expect(ghosts).toEqual([]);
  });
});
