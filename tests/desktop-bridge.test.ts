// The desktop bridge: the renderer's same-origin view of the shell's
// version and update state, driven here by a fake updater and no Electron.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createBridge, isBridgeRequest, BRIDGE_PATH, INSTALL_PATH, CHECK_PATH, CHECK_INTERVAL_MS } = require("../desktop/bridge.js");

type Bridge = ReturnType<typeof createBridge>;

class FakeUpdater extends EventEmitter {
  checkForUpdates = vi.fn(() => Promise.resolve());
  // The periodic check calls this one, not checkForUpdates. The fake modelled
  // only the two methods the request handlers touched, so the six-hour loop —
  // which named a third — could have called anything at all, including a
  // method electron-updater does not have, and every test here still passed.
  checkForUpdatesAndNotify = vi.fn(() => Promise.resolve());
  quitAndInstall = vi.fn();
}

const ORIGIN = "app://rom-nova";
const req = (path: string, method = "GET") => new Request(`${ORIGIN}${path}`, { method });
const body = async (res: Response) => ({ status: res.status, json: await res.json() });

function packaged(now = () => 1_700_000_000_000): { bridge: Bridge; updater: FakeUpdater } {
  const updater = new FakeUpdater();
  const bridge = createBridge({
    version: () => "1.26.0",
    platform: "win32",
    arch: "x64",
    versions: { electron: "33.4.11", chrome: "130.0.0.0" },
    updater,
    now,
  });
  return { bridge, updater };
}

describe("isBridgeRequest", () => {
  it("claims exactly the three shell paths", () => {
    expect(isBridgeRequest(BRIDGE_PATH)).toBe(true);
    expect(isBridgeRequest(INSTALL_PATH)).toBe(true);
    expect(isBridgeRequest(CHECK_PATH)).toBe(true);
    expect(isBridgeRequest("/nova/")).toBe(false);
    expect(isBridgeRequest("/nova/__desktop/")).toBe(false);
    expect(isBridgeRequest("/nova/__rpc/solana")).toBe(false);
  });
});

describe("the unpackaged shell", () => {
  const bridge: Bridge = createBridge({ version: () => "0.0.0-dev", platform: "win32", arch: "x64" });

  it("reports that there is no update feed", async () => {
    const { status, json } = await body(await bridge.handle(req(BRIDGE_PATH)));
    expect(status).toBe(200);
    expect(json.version).toBe("0.0.0-dev");
    expect(json.electron).toBeNull();
    expect(json.update.state).toBe("unavailable");
  });

  it("refuses to check or install", async () => {
    expect((await bridge.handle(req(CHECK_PATH, "POST"))).status).toBe(409);
    expect((await bridge.handle(req(INSTALL_PATH, "POST"))).status).toBe(409);
    expect(bridge.shouldCheck()).toBe(false);
  });
});

describe("the packaged shell", () => {
  it("answers the GET with the shell's facts and an idle updater", async () => {
    const { bridge } = packaged();
    const { status, json } = await body(await bridge.handle(req(BRIDGE_PATH)));
    expect(status).toBe(200);
    expect(json).toMatchObject({ version: "1.26.0", platform: "win32", arch: "x64", electron: "33.4.11", chrome: "130.0.0.0" });
    expect(json.update).toMatchObject({ state: "idle", version: null, percent: null, error: null, checkedAt: null });
  });

  it("holds the verbs to their paths", async () => {
    const { bridge } = packaged();
    expect((await bridge.handle(req(BRIDGE_PATH, "POST"))).status).toBe(405);
    expect((await bridge.handle(req(CHECK_PATH, "GET"))).status).toBe(405);
    expect((await bridge.handle(req(INSTALL_PATH, "GET"))).status).toBe(405);
    expect((await bridge.handle(req("/nova/__desktop/other", "GET"))).status).toBe(404);
  });

  it("follows the updater's events one to one", () => {
    let t = 1000;
    const { bridge, updater } = packaged(() => t++);
    updater.emit("checking-for-update");
    expect(bridge.update.state).toBe("checking");
    updater.emit("update-available", { version: "1.27.0" });
    expect(bridge.update).toMatchObject({ state: "available", version: "1.27.0", percent: 0 });
    expect(bridge.update.checkedAt).not.toBeNull();
    updater.emit("download-progress", { percent: 41.6 });
    expect(bridge.update).toMatchObject({ state: "downloading", percent: 42 });
    updater.emit("update-downloaded", { version: "1.27.0" });
    expect(bridge.update).toMatchObject({ state: "ready", version: "1.27.0", percent: 100 });
  });

  it("records no update and errors without throwing", () => {
    const { bridge, updater } = packaged();
    updater.emit("update-not-available", { version: "1.26.0" });
    expect(bridge.update).toMatchObject({ state: "none", version: "1.26.0" });
    // An "error" on a Node emitter with no listener throws; the bridge is that listener.
    expect(() => updater.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"))).not.toThrow();
    expect(bridge.update).toMatchObject({ state: "error", error: "net::ERR_INTERNET_DISCONNECTED" });
    updater.emit("error", undefined);
    expect(bridge.update.error).toBe("update check failed");
  });

  it("checks only when nothing is in flight or finished", () => {
    const { bridge, updater } = packaged();
    expect(bridge.shouldCheck()).toBe(true);
    updater.emit("checking-for-update");
    expect(bridge.shouldCheck()).toBe(false);
    updater.emit("update-available", { version: "1.27.0" });
    expect(bridge.shouldCheck()).toBe(false);
    updater.emit("download-progress", { percent: 10 });
    expect(bridge.shouldCheck()).toBe(false);
    updater.emit("update-downloaded", { version: "1.27.0" });
    expect(bridge.shouldCheck()).toBe(false);
    const fresh = packaged();
    fresh.updater.emit("update-not-available", {});
    expect(fresh.bridge.shouldCheck()).toBe(true);
    fresh.updater.emit("error", new Error("offline"));
    expect(fresh.bridge.shouldCheck()).toBe(true);
  });

  it("POST /check asks the updater once and never over a finished download", async () => {
    const { bridge, updater } = packaged();
    const first = await body(await bridge.handle(req(CHECK_PATH, "POST")));
    expect(first.status).toBe(200);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    updater.emit("update-downloaded", { version: "1.27.0" });
    const second = await body(await bridge.handle(req(CHECK_PATH, "POST")));
    expect(second.status).toBe(200);
    expect(second.json.update.state).toBe("ready");
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("a rejected check surfaces as the error event, not a crash", async () => {
    const { bridge, updater } = packaged();
    updater.checkForUpdates.mockImplementation(() => Promise.reject(new Error("feed down")));
    await bridge.handle(req(CHECK_PATH, "POST"));
    await Promise.resolve();
    await Promise.resolve();
    // electron-updater emits "error" itself for a failed check; the bridge
    // only has to survive the rejection, which it swallowed.
    expect(bridge.update.state).toBe("idle");
  });

  describe("POST /install", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("refuses until an update is downloaded", async () => {
      const { bridge, updater } = packaged();
      updater.emit("update-available", { version: "1.27.0" });
      const { status, json } = await body(await bridge.handle(req(INSTALL_PATH, "POST")));
      expect(status).toBe(409);
      expect(json.update.state).toBe("available");
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
    });

    it("answers first, then restarts into the downloaded update", async () => {
      const { bridge, updater } = packaged();
      updater.emit("update-downloaded", { version: "1.27.0" });
      const { status, json } = await body(await bridge.handle(req(INSTALL_PATH, "POST")));
      expect(status).toBe(200);
      expect(json).toEqual({ ok: true, installing: "1.27.0" });
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
  });
});

// This loop ran inline in main.js — `if (bridge.shouldCheck())
// updater.checkForUpdatesAndNotify().catch(...)` on a six-hour setInterval —
// where no test could reach it: main.js destructures Electron at the top level
// and registers a privileged scheme on import, so vitest cannot load the file
// at all. It now lives beside the update state it reads.
describe("the six-hour check on a window left open", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Each tick hands the call to a microtask on purpose: an updater with no
  // checkForUpdatesAndNotify throws SYNCHRONOUSLY, and a bare .catch() on a
  // synchronous throw never runs — that first tick would have taken the main
  // process down. So every assertion here has to let the queue drain first.
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it("asks once on start, then again on every interval", async () => {
    const { bridge, updater } = packaged();
    const timer = bridge.startPeriodicChecks();
    await flush();
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    // The notifying variant, not the one the Settings page's POST uses.
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(5);
    clearInterval(timer);
  });

  it("goes quiet once an update is downloaded and waiting", async () => {
    const { bridge, updater } = packaged();
    const timer = bridge.startPeriodicChecks();
    await flush();
    updater.emit("update-downloaded", { version: "1.28.0" });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 4);
    // Re-checking a finished download makes electron-updater announce it
    // again: one OS notification per tick for an update already waiting.
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    clearInterval(timer);
  });

  it("starts no timer for the unpackaged shell, which has no feed to ask", () => {
    const bridge: Bridge = createBridge({ version: () => "0.0.0-dev", platform: "win32", arch: "x64" });
    expect(bridge.startPeriodicChecks()).toBeNull();
    expect(bridge.checkPeriodically()).toBe(false);
  });

  it("survives an updater whose API is not the one it was written against", async () => {
    // The call is wrapped in a resolved promise for exactly this: a missing
    // method throws synchronously, where a `.catch()` on the call itself never
    // runs — so this test fails by killing the main process, not by asserting.
    const { bridge, updater } = packaged();
    delete (updater as Partial<FakeUpdater>).checkForUpdatesAndNotify;
    const timer = bridge.startPeriodicChecks();
    await Promise.resolve();
    expect(bridge.update.state).toBe("idle");
    clearInterval(timer);
  });
});
