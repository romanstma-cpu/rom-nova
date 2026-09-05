/* eslint-disable @typescript-eslint/no-require-imports -- Electron main process: CommonJS by nature */
// The window comes back the way it was left.
//
// Every launch opened 1480×920 in the middle of the primary display, whatever
// the reader had dragged it to last time — the one habit that marks a web
// page in a frame rather than an installed app. The bounds, the maximized
// flag and the zoom level are written to a small JSON file in userData, and
// read back through a check against the displays that exist NOW: a window
// last seen on a monitor that has since been unplugged would otherwise open
// off-screen, with no edge to grab.
//
// Pure functions over injected values, so the test needs no Electron.

const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "window-state.json";

const DEFAULT_BOUNDS = { width: 1480, height: 920 };
const MIN_BOUNDS = { width: 960, height: 620 };

/** Zoom is Chromium's level scale (factor = 1.2^level). ±3 spans 58%–173%. */
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 3;

/** How much of the window must sit on some display for its position to be trusted. */
const VISIBLE_PX = { width: 160, height: 60 };

function stateFile(userDataDir) {
  return path.join(userDataDir, FILE_NAME);
}

function finiteInt(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
}

/** A parsed file, or nothing — a corrupt file is the same as no file. */
function sanitize(raw) {
  if (!raw || typeof raw !== "object") return null;
  const width = finiteInt(raw.width);
  const height = finiteInt(raw.height);
  if (width === undefined || height === undefined) return null;
  const zoom = typeof raw.zoom === "number" && Number.isFinite(raw.zoom) ? clampZoom(raw.zoom) : 0;
  return {
    width,
    height,
    x: finiteInt(raw.x),
    y: finiteInt(raw.y),
    maximized: raw.maximized === true,
    zoom,
  };
}

function readState(file) {
  try {
    return sanitize(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/** Writes atomically (temp file, then rename) and never throws: losing the memory is not worth a crash. */
function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bounds to open with, given what was saved and the displays present.
 *
 * Size is clamped between the minimum and the largest work area. Position is
 * kept only when at least VISIBLE_PX of the window's top-left region lies on
 * some display's work area — that is where the title bar is, and a title bar
 * the reader can reach is the whole test. Otherwise x and y are dropped and
 * Electron centres the window.
 *
 * @param {ReturnType<typeof sanitize>} saved
 * @param {{workArea: {x: number, y: number, width: number, height: number}}[]} displays
 */
function fitToDisplays(saved, displays) {
  const areas = (displays || []).map((d) => d.workArea).filter(Boolean);
  const largest = areas.reduce(
    (best, a) => (a.width * a.height > best.width * best.height ? a : best),
    { width: DEFAULT_BOUNDS.width, height: DEFAULT_BOUNDS.height },
  );
  const base = saved || { ...DEFAULT_BOUNDS, maximized: false, zoom: 0 };
  const width = Math.max(MIN_BOUNDS.width, Math.min(base.width, largest.width));
  const height = Math.max(MIN_BOUNDS.height, Math.min(base.height, largest.height));
  const out = { width, height, maximized: base.maximized === true, zoom: clampZoom(base.zoom || 0) };
  if (base.x !== undefined && base.y !== undefined) {
    const visible = areas.some((a) => {
      const left = Math.max(base.x, a.x);
      const top = Math.max(base.y, a.y);
      const right = Math.min(base.x + width, a.x + a.width);
      const bottom = Math.min(base.y + height, a.y + a.height);
      return right - left >= VISIBLE_PX.width && bottom - top >= VISIBLE_PX.height;
    });
    if (visible) {
      out.x = base.x;
      out.y = base.y;
    }
  }
  return out;
}

/**
 * What to remember about a window, read through the two methods a
 * BrowserWindow offers: normal bounds survive maximizing, so un-maximizing
 * next launch lands where the reader left the un-maximized window.
 */
function captureState(win, zoom) {
  const bounds = win.getNormalBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: win.isMaximized(),
    zoom: clampZoom(zoom || 0),
  };
}

function clampZoom(level) {
  const snapped = Math.round(level / ZOOM_STEP) * ZOOM_STEP;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, snapped));
}

/** The zoom level after one keypress: +1 steps in, -1 steps out, 0 resets. */
function nextZoom(current, direction) {
  if (direction === 0) return 0;
  return clampZoom((current || 0) + Math.sign(direction) * ZOOM_STEP);
}

/**
 * Which shell action a key press asks for, or null. Ctrl on Windows and
 * Linux, Cmd on macOS; the plus key arrives as "=" unshifted and "+" shifted,
 * and the numeric keypad has its own codes.
 *
 * @param {{type: string, key: string, code?: string, control?: boolean, meta?: boolean, shift?: boolean, alt?: boolean}} input
 */
function shellActionFor(input) {
  if (!input || input.type !== "keyDown") return null;
  const key = input.key || "";
  const mod = Boolean(input.control || input.meta);
  if (key === "F11") return "fullscreen";
  if (key === "F5" || (mod && !input.shift && key.toLowerCase() === "r")) return "reload";
  if (key === "F12" || (mod && input.shift && key.toLowerCase() === "i")) return "devtools";
  if (!mod || input.alt) return null;
  if (key === "=" || key === "+" || input.code === "NumpadAdd") return "zoom-in";
  if (key === "-" || key === "_" || input.code === "NumpadSubtract") return "zoom-out";
  if (key === "0" || input.code === "Numpad0") return "zoom-reset";
  return null;
}

module.exports = {
  FILE_NAME,
  DEFAULT_BOUNDS,
  MIN_BOUNDS,
  ZOOM_STEP,
  ZOOM_MIN,
  ZOOM_MAX,
  stateFile,
  sanitize,
  readState,
  writeState,
  fitToDisplays,
  captureState,
  clampZoom,
  nextZoom,
  shellActionFor,
};
