// A dead renderer: brought back while that can still help, left alone once
// bringing it back is the only thing the shell would ever do again.
//
// This ran inline in main.js, which no test can import — Electron destructured
// at the top level, a privileged scheme registered on load — so nothing about
// it was ever exercised, including its comment's claim that a page crashing on
// load could not loop. It could: the old guard refused only a second reload
// within a minute of the last one, which bounds the rate and never the total.

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCrashGuard, MAX_RELOADS, STEADY_MS } = require("../desktop/crash-guard.js");

const CRASH = { reason: "crashed" };
const OOM = { reason: "oom" };

describe("the crash guard", () => {
  it("leaves an exit that was asked for alone", () => {
    const guard = createCrashGuard();
    expect(guard.crashed({ reason: "clean-exit" })).toBe("ignore");
    expect(guard.crashed({ reason: "killed" })).toBe("ignore");
  });

  it("brings back a renderer that died on its own, details or not", () => {
    expect(createCrashGuard().crashed(CRASH)).toBe("reload");
    expect(createCrashGuard().crashed(undefined)).toBe("reload");
  });

  it("gives up on a page that never finishes loading", () => {
    // The loop the old guard let through: deaths an hour apart clear its
    // one-minute window every single time, so it reloaded forever.
    let t = 0;
    const guard = createCrashGuard({ now: () => t });
    const actions: string[] = [];
    for (let i = 0; i < MAX_RELOADS + 2; i++) {
      t += 60 * 60 * 1000;
      actions.push(guard.crashed(OOM));
    }
    expect(actions.slice(0, MAX_RELOADS)).toEqual(Array(MAX_RELOADS).fill("reload"));
    expect(actions.slice(MAX_RELOADS)).toEqual(["ignore", "ignore"]);
  });

  it("hands a fresh budget to a renderer that had been up a while", () => {
    let t = 1_000_000;
    const guard = createCrashGuard({ now: () => t });
    expect(guard.crashed(CRASH)).toBe("reload");
    expect(guard.crashed(CRASH)).toBe("reload");
    guard.loaded();
    t += STEADY_MS;
    // Loaded, used for a minute, then died under the 3D scene: an incident,
    // not a page that cannot start.
    expect(guard.crashed(OOM)).toBe("reload");
    expect(guard.crashed(CRASH)).toBe("reload");
    expect(guard.crashed(CRASH)).toBe("reload");
    expect(guard.crashed(CRASH)).toBe("ignore");
  });

  it("counts a page that comes up and falls straight back over", () => {
    let t = 0;
    const guard = createCrashGuard({ now: () => t });
    for (let i = 0; i < MAX_RELOADS; i++) {
      expect(guard.crashed(CRASH)).toBe("reload");
      guard.loaded();
      t += 2_000; // it rendered, then fell over two seconds later
    }
    expect(guard.crashed(CRASH)).toBe("ignore");
  });
});
