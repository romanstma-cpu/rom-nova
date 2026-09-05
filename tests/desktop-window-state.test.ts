// The remembered window: saved bounds checked against the displays that
// exist now, the zoom steps, and the shell's own key bindings.

import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const ws = require("../desktop/window-state.js");

const DISPLAY = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const SECOND = { workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };

describe("sanitize", () => {
  it("rejects anything that is not a sized window", () => {
    expect(ws.sanitize(null)).toBeNull();
    expect(ws.sanitize("wide")).toBeNull();
    expect(ws.sanitize({ width: "1200", height: 800 })).toBeNull();
    expect(ws.sanitize({ width: Infinity, height: 800 })).toBeNull();
    expect(ws.sanitize({ height: 800 })).toBeNull();
  });

  it("rounds, drops a missing position and clamps the zoom", () => {
    expect(ws.sanitize({ width: 1200.4, height: 799.6, x: 10.5, y: 20.2, maximized: "yes", zoom: 9 })).toEqual({
      width: 1200,
      height: 800,
      x: 11,
      y: 20,
      maximized: false,
      zoom: 3,
    });
    expect(ws.sanitize({ width: 1200, height: 800, maximized: true })).toEqual({
      width: 1200,
      height: 800,
      x: undefined,
      y: undefined,
      maximized: true,
      zoom: 0,
    });
  });
});

describe("the state file", () => {
  const dirs: string[] = [];
  const scratch = () => {
    const d = mkdtempSync(path.join(tmpdir(), "nova-ws-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("reads nothing from a missing or corrupt file", () => {
    const d = scratch();
    const file = ws.stateFile(d);
    expect(file.endsWith(ws.FILE_NAME)).toBe(true);
    expect(ws.readState(file)).toBeNull();
    writeFileSync(file, "{not json", "utf8");
    expect(ws.readState(file)).toBeNull();
  });

  it("round-trips through the disk and leaves no temp file behind", () => {
    const d = scratch();
    const file = ws.stateFile(path.join(d, "nested", "userData"));
    const state = { x: 40, y: 30, width: 1200, height: 800, maximized: false, zoom: 0.5 };
    expect(ws.writeState(file, state)).toBe(true);
    expect(ws.readState(file)).toEqual(state);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(state);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it("reports a failed write instead of throwing", () => {
    const d = scratch();
    // A file where the directory should be: mkdir and the write both fail.
    writeFileSync(path.join(d, "userData"), "occupied", "utf8");
    expect(ws.writeState(path.join(d, "userData", ws.FILE_NAME), { width: 1, height: 1 })).toBe(false);
  });
});

describe("fitToDisplays", () => {
  it("opens with the defaults and no position when nothing was saved", () => {
    expect(ws.fitToDisplays(null, [DISPLAY])).toEqual({ width: 1480, height: 920, maximized: false, zoom: 0 });
  });

  it("keeps a position that is on a display", () => {
    const saved = { width: 1200, height: 800, x: 300, y: 100, maximized: false, zoom: 0 };
    expect(ws.fitToDisplays(saved, [DISPLAY])).toEqual({ width: 1200, height: 800, x: 300, y: 100, maximized: false, zoom: 0 });
  });

  it("drops a position that fell off the displays", () => {
    const saved = { width: 1200, height: 800, x: 5000, y: 100, maximized: false, zoom: 0 };
    const fit = ws.fitToDisplays(saved, [DISPLAY]);
    expect(fit.x).toBeUndefined();
    expect(fit.y).toBeUndefined();
    expect(fit.width).toBe(1200);
  });

  it("trusts a second display that is still plugged in", () => {
    const saved = { width: 1200, height: 800, x: 2400, y: 200, maximized: true, zoom: -1 };
    expect(ws.fitToDisplays(saved, [DISPLAY, SECOND])).toEqual({ width: 1200, height: 800, x: 2400, y: 200, maximized: true, zoom: -1 });
    expect(ws.fitToDisplays(saved, [DISPLAY]).x).toBeUndefined();
  });

  it("wants a grabbable corner, not a sliver", () => {
    // 100 px of the window remain on screen: less than the 160 required.
    const sliver = { width: 1200, height: 800, x: 1820, y: 100, maximized: false, zoom: 0 };
    expect(ws.fitToDisplays(sliver, [DISPLAY]).x).toBeUndefined();
    // The title bar hangs above the top edge with nothing to grab.
    const above = { width: 1200, height: 800, x: 100, y: -790, maximized: false, zoom: 0 };
    expect(ws.fitToDisplays(above, [DISPLAY]).y).toBeUndefined();
  });

  it("clamps the size between the minimum and the largest work area", () => {
    const huge = { width: 9000, height: 9000, x: 0, y: 0, maximized: false, zoom: 0 };
    expect(ws.fitToDisplays(huge, [DISPLAY, SECOND])).toMatchObject({ width: 2560, height: 1400 });
    const tiny = { width: 10, height: 10, x: 0, y: 0, maximized: false, zoom: 0 };
    expect(ws.fitToDisplays(tiny, [DISPLAY])).toMatchObject({ width: 960, height: 620, x: 0, y: 0 });
  });

  it("with no display information keeps the size and centres", () => {
    const saved = { width: 1300, height: 700, x: 10, y: 10, maximized: false, zoom: 0 };
    const fit = ws.fitToDisplays(saved, []);
    expect(fit).toMatchObject({ width: 1300, height: 700 });
    expect(fit.x).toBeUndefined();
  });
});

describe("captureState", () => {
  it("reads the normal bounds so a maximized window remembers its un-maximized place", () => {
    const win = {
      getNormalBounds: () => ({ x: 12, y: 34, width: 1300, height: 760 }),
      isMaximized: () => true,
    };
    expect(ws.captureState(win, 1)).toEqual({ x: 12, y: 34, width: 1300, height: 760, maximized: true, zoom: 1 });
    expect(ws.captureState(win, undefined).zoom).toBe(0);
  });
});

describe("zoom", () => {
  it("steps by a half level and stops at the ends", () => {
    expect(ws.nextZoom(0, 1)).toBe(0.5);
    expect(ws.nextZoom(0.5, -1)).toBe(0);
    expect(ws.nextZoom(2.8, 1)).toBe(3);
    expect(ws.nextZoom(3, 1)).toBe(3);
    expect(ws.nextZoom(-3, -1)).toBe(-3);
    expect(ws.nextZoom(1.5, 0)).toBe(0);
    expect(ws.clampZoom(0.74)).toBe(0.5);
    expect(ws.clampZoom(-7)).toBe(-3);
  });
});

describe("shellActionFor", () => {
  const down = (key: string, mods: Partial<{ control: boolean; meta: boolean; shift: boolean; alt: boolean; code: string }> = {}) => ({
    type: "keyDown",
    key,
    ...mods,
  });

  it("maps the shell's keys", () => {
    expect(ws.shellActionFor(down("F11"))).toBe("fullscreen");
    expect(ws.shellActionFor(down("F5"))).toBe("reload");
    expect(ws.shellActionFor(down("r", { control: true }))).toBe("reload");
    expect(ws.shellActionFor(down("R", { meta: true }))).toBe("reload");
    expect(ws.shellActionFor(down("F12"))).toBe("devtools");
    expect(ws.shellActionFor(down("I", { control: true, shift: true }))).toBe("devtools");
    expect(ws.shellActionFor(down("=", { control: true }))).toBe("zoom-in");
    expect(ws.shellActionFor(down("+", { control: true, shift: true }))).toBe("zoom-in");
    expect(ws.shellActionFor(down("Add", { control: true, code: "NumpadAdd" }))).toBe("zoom-in");
    expect(ws.shellActionFor(down("-", { control: true }))).toBe("zoom-out");
    expect(ws.shellActionFor(down("0", { control: true }))).toBe("zoom-reset");
  });

  it("leaves ordinary typing alone", () => {
    expect(ws.shellActionFor(down("r"))).toBeNull();
    expect(ws.shellActionFor(down("="))).toBeNull();
    expect(ws.shellActionFor(down("k", { control: true }))).toBeNull();
    expect(ws.shellActionFor(down("=", { control: true, alt: true }))).toBeNull();
    expect(ws.shellActionFor({ type: "keyUp", key: "F5" })).toBeNull();
    expect(ws.shellActionFor(null)).toBeNull();
  });
});
