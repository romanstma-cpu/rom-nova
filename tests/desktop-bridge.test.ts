// The desktop bridge: the renderer's same-origin view of the shell's
// version and update state, driven here by a fake updater and no Electron.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createBridge, isBridgeRequest, BRIDGE_PATH, INSTALL_PATH, CHECK_PATH } = require("../desktop/bridge.js");

type Bridge = ReturnType<typeof createBridge>;

class FakeUpdater extends EventEmitter {
  checkForUpdates = vi.fn(() => Promise.resolve());
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
