// The words a broken page uses, and the block a reader copies to report it.

import { describe, it, expect } from "vitest";
import { describeError, errorReport, isWebGLFailure } from "../src/lib/error-report";

const AT = new Date("2026-09-05T15:04:05.000Z");

describe("errorReport", () => {
  it("names the build, the page, the time, the browser and the error, in that order", () => {
    const text = errorReport({
      error: { name: "TypeError", message: "x is not a function", stack: "TypeError: x is not a function\n    at a (b.js:1:2)\n    at c (d.js:3:4)" },
      version: "1.26.0",
      path: "/nova/whale/?a=abc",
      userAgent: "TestBrowser/1.0",
      at: AT,
      desktop: false,
    });
    expect(text.split("\n")).toEqual([
      "ROM Nova 1.26.0 (web)",
      "page: /nova/whale/?a=abc",
      "when: 2026-09-05T15:04:05.000Z",
      "browser: TestBrowser/1.0",
      "error: TypeError: x is not a function",
      "",
      "TypeError: x is not a function",
      "    at a (b.js:1:2)",
      "    at c (d.js:3:4)",
    ]);
  });

  it("marks the desktop, keeps the digest, and drops the hash from the path", () => {
    const text = errorReport({
      error: { message: "boom", digest: "d1g3st" },
      version: "1.26.0",
      path: "/nova/account/#access_token=secret",
      userAgent: "UA",
      at: AT,
      desktop: true,
    });
    expect(text).toContain("ROM Nova 1.26.0 (desktop)");
    expect(text).toContain("page: /nova/account/");
    expect(text).not.toContain("secret");
    expect(text).toContain("digest: d1g3st");
    // A stack of one line is the message again; no stack section.
    expect(text.split("\n")).toHaveLength(6);
  });

  it("caps the stack and survives a missing error", () => {
    const stack = ["Error: deep", ...Array.from({ length: 40 }, (_, i) => `    at frame${i} (f.js:${i}:1)`)].join("\n");
    const text = errorReport({ error: { message: "deep", stack }, version: "1.26.0", path: "/", userAgent: "UA", at: AT });
    const frames = text.split("\n").filter((l) => l.startsWith("    at "));
    expect(frames).toHaveLength(11);
    const empty = errorReport({ error: null, version: "dev", path: "/", userAgent: "UA", at: AT });
    expect(empty).toContain("error: Error: (no message)");
  });
});

describe("describeError", () => {
  it("tells a stale tab to reload", () => {
    const d = describeError({ name: "ChunkLoadError", message: "Loading chunk 123 failed." });
    expect(d.reload).toBe(true);
    expect(d.title).toMatch(/failed to load/);
    expect(describeError({ message: "Failed to fetch dynamically imported module: /nova/_next/x.js" }).reload).toBe(true);
  });

  it("names a missing WebGL context", () => {
    const d = describeError({ message: "Error creating WebGL context." });
    expect(d.reload).toBe(false);
    expect(d.title).toMatch(/3D graphics/);
    // The marker does not always ride in the message. This is the case the
    // scene's own private copy of the test used to miss, because it read the
    // message alone and this reads the name too.
    expect(describeError({ name: "WebGLContextEvent", message: "context creation failed" }).title).toMatch(/3D graphics/);
  });

  it("owns the WebGL test the scene's fallback panel shares", () => {
    expect(isWebGLFailure({ message: "THREE.WebGLRenderer: Error creating WebGL context." })).toBe(true);
    expect(isWebGLFailure({ name: "WebGLContextEvent", message: "context creation failed" })).toBe(true);
    expect(isWebGLFailure({ name: "TypeError", message: "Cannot read properties of undefined" })).toBe(false);
    expect(isWebGLFailure(null)).toBe(false);
  });

  it("everything else is a broken page with the rest of the app intact", () => {
    const d = describeError({ name: "TypeError", message: "Cannot read properties of undefined" });
    expect(d.reload).toBe(false);
    expect(d.advice).toMatch(/rest of the app is fine/);
    expect(describeError(null).title).toBe(d.title);
  });
});
