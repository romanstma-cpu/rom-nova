// The number the app says it is.
//
// Three surfaces identify a build to a reader: the footer link
// (src/components/chrome/Shell.tsx), Settings → About
// (src/components/settings/AboutPanel.tsx), and the block copied out of a
// crash (src/app/error.tsx). All three print APP_VERSION, which is whatever
// next.config.ts read out of desktop/package.json at build time.
//
// Nothing asserted any of it. desktopVersion() resolves its path against
// process.cwd() and swallows every error, so a build launched from another
// directory — or a desktop/package.json that lost its "version" key — stamps
// the literal "dev": the build succeeds, romapps.xyz/nova ships "vdev", and
// every installed copy lights the About panel's "shell and pages were built
// from different versions" chip forever, because the Electron shell goes on
// reporting its own real version. `npm test`, `npm run lint` and
// `tsc --noEmit` all stayed green through that.
//
// This runs no build. It asserts the config object the build reads, and both
// branches of the read behind it.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import nextConfig, { desktopVersion } from "../next.config";

// From this file's own location, never from the ambient cwd — a stamp that
// resolved against some other directory is exactly what this has to catch.
const root = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const pkg = JSON.parse(readFileSync(path.join(root, "desktop", "package.json"), "utf8")) as { version?: string };
const declared = pkg.version ?? "";

describe("the build stamps the version the release drill bumped", () => {
  const dirs: string[] = [];
  const scratch = () => {
    const d = mkdtempSync(path.join(tmpdir(), "nova-version-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("carries desktop/package.json's version into NEXT_PUBLIC_APP_VERSION", () => {
    // Both halves are checked, so the comparison below cannot pass by having
    // said "dev" on each side.
    expect(declared, 'desktop/package.json carries no usable version — every build from this tree would stamp "dev"').toMatch(/^\d+\.\d+\.\d+/);
    expect(
      nextConfig.env?.NEXT_PUBLIC_APP_VERSION,
      `the config stamps this while desktop/package.json says ${declared}; desktopVersion() reads relative to process.cwd(), which is ${process.cwd()}`,
    ).toBe(declared);
  });

  it("resolves the package against the root it is handed", () => {
    expect(desktopVersion(root)).toBe(declared);
  });

  it('answers "dev" when there is no desktop/package.json under the root', () => {
    // The live failure: `next build` launched from anywhere but the repo root.
    expect(desktopVersion(path.join(root, "no-such-checkout"))).toBe("dev");
  });

  it('answers "dev" for a package with no version, an empty version, or unparseable JSON', () => {
    const file = path.join(scratch(), "desktop", "package.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const asks = path.dirname(path.dirname(file));

    writeFileSync(file, JSON.stringify({ name: "rom-nova-desktop" }));
    expect(desktopVersion(asks)).toBe("dev");

    // Never the empty string. A footer reading "v" is a build that forgot to
    // say which one it is — the single thing the version exists to prevent.
    writeFileSync(file, JSON.stringify({ version: "" }));
    expect(desktopVersion(asks)).toBe("dev");

    writeFileSync(file, '{ "version": "1.27.1"');
    expect(desktopVersion(asks)).toBe("dev");
  });
});

describe("APP_VERSION — the string the footer, the About panel and a crash report print", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is whatever the build stamped", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", declared);
    vi.resetModules();
    const { APP_VERSION } = await import("../src/lib/version");
    expect(APP_VERSION).toBe(declared);
  });

  it('is "dev" when nothing stamped it, so an unidentified build cannot pass for a released one', async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", undefined);
    vi.resetModules();
    const unset = await import("../src/lib/version");
    expect(unset.APP_VERSION).toBe("dev");

    // A CI that exports the variable empty is the same story with a different
    // shape, and it must not reach the footer as a blank.
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "");
    vi.resetModules();
    const empty = await import("../src/lib/version");
    expect(empty.APP_VERSION).toBe("dev");
  });
});
