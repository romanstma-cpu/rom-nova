// The page's view of the desktop shell: nothing fetched in a browser, the
// bridge read under app://, the words for each update state, and the gate
// that decides whether the shell's update banner is on screen.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkDesktopUpdate,
  describeUpdate,
  desktopSeams,
  desktopServerSnapshot,
  desktopSnapshot,
  installDesktopUpdate,
  isDesktop,
  refreshDesktop,
  resetDesktopStore,
  subscribeDesktop,
  updateBannerReady,
  updateBannerVersion,
  type DesktopUpdate,
} from "../src/lib/desktop";

const shellJson = (update: Partial<DesktopUpdate> = {}) => ({
  version: "1.26.0",
  platform: "win32",
  arch: "x64",
  electron: "33.4.11",
  chrome: "130.0.0.0",
  update: { state: "idle", version: null, percent: null, error: null, checkedAt: null, ...update },
});

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): typeof fetch {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  resetDesktopStore();
  desktopSeams.protocol = null;
  desktopSeams.fetch = null;
});
afterEach(() => {
  resetDesktopStore();
  desktopSeams.protocol = null;
  desktopSeams.fetch = null;
});

describe("in a browser", () => {
  it("is not the desktop and never fetches", async () => {
    const f = fakeFetch(() => ({ status: 200, body: shellJson() }));
    desktopSeams.fetch = f;
    desktopSeams.protocol = "https:";
    expect(isDesktop()).toBe(false);
    const unsub = subscribeDesktop(() => {});
    await refreshDesktop();
    await flush();
    expect(f).not.toHaveBeenCalled();
    expect(desktopSnapshot()).toBe(desktopServerSnapshot());
    expect(await installDesktopUpdate()).toEqual({ ok: false, error: "not the desktop app" });
    expect(await checkDesktopUpdate()).toEqual({ ok: false, error: "not the desktop app" });
    unsub();
  });
});

describe("under app://", () => {
  beforeEach(() => {
    desktopSeams.protocol = "app:";
  });

  it("is the desktop at once and reads the shell on the first subscribe", async () => {
    desktopSeams.fetch = fakeFetch(() => ({ status: 200, body: shellJson({ state: "none", checkedAt: 5 }) }));
    let notified = 0;
    const unsub = subscribeDesktop(() => notified++);
    expect(desktopSnapshot()).toMatchObject({ desktop: true, reachable: null, version: null });
    await flush();
    expect(desktopSnapshot()).toMatchObject({
      desktop: true,
      reachable: true,
      answered: true,
      version: "1.26.0",
      platform: "win32",
      electron: "33.4.11",
      update: { state: "none", checkedAt: 5 },
    });
    expect(notified).toBeGreaterThan(0);
    unsub();
  });

  it("an older shell without the bridge is still the desktop", async () => {
    desktopSeams.fetch = fakeFetch(() => ({ status: 404, body: "not found" }));
    const unsub = subscribeDesktop(() => {});
    await flush();
    expect(desktopSnapshot()).toMatchObject({ desktop: true, reachable: false, answered: false, version: null });
    expect(describeUpdate(desktopSnapshot().update, false, false)).toMatch(/predates the update bridge/);
    unsub();
  });

  it("normalises garbage in the shell's answer", async () => {
    desktopSeams.fetch = fakeFetch(() => ({ status: 200, body: { version: 12, update: { state: "weird", percent: "50", version: 3 } } }));
    await refreshDesktop();
    expect(desktopSnapshot().version).toBeNull();
    expect(desktopSnapshot().update).toEqual({ state: "unavailable", version: null, percent: null, error: null, checkedAt: null });
  });

  it("a check posts once, then re-reads the shell on a schedule", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      desktopSeams.fetch = fakeFetch((url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return { status: 200, body: url.endsWith("/check") ? { ok: true } : shellJson({ state: "checking" }) };
      });
      const r = await checkDesktopUpdate();
      expect(r).toEqual({ ok: true, error: null });
      expect(calls).toEqual(["POST /nova/__desktop/check"]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls.filter((c) => c === "GET /nova/__desktop")).toHaveLength(3);
      expect(desktopSnapshot().update.state).toBe("checking");
    } finally {
      vi.useRealTimers();
    }
  });

  it("install reports the shell's refusal in its own words", async () => {
    desktopSeams.fetch = fakeFetch(() => ({ status: 409, body: { error: "no update is downloaded and ready to install" } }));
    expect(await installDesktopUpdate()).toEqual({ ok: false, error: "no update is downloaded and ready to install" });
  });

  it("a dead bridge is an error in words, not a throw", async () => {
    desktopSeams.fetch = vi.fn(async () => {
      throw new Error("net down");
    }) as unknown as typeof fetch;
    expect(await installDesktopUpdate()).toEqual({ ok: false, error: "net down" });
    await refreshDesktop();
    expect(desktopSnapshot()).toMatchObject({ desktop: true, reachable: false, answered: false });
  });

  it("a poll that fails stops speaking for the updater it could not read", async () => {
    // The regression this pins: the failure branch spread the last good
    // answer forward, so a bridge that stopped answering shipped
    // `reachable: false` next to a live "ready" state, its percent and its
    // checkedAt — Settings kept the "Restart to install" button and printed
    // how long ago it had "checked". Both older failure tests poll from a
    // reset store, so neither ever drove success -> failure.
    desktopSeams.fetch = fakeFetch(() => ({
      status: 200,
      body: shellJson({ state: "ready", version: "1.28.0", percent: 100, checkedAt: 12_345 }),
    }));
    await refreshDesktop();
    expect(desktopSnapshot()).toMatchObject({
      reachable: true,
      answered: true,
      update: { state: "ready", version: "1.28.0", percent: 100, checkedAt: 12_345 },
    });

    desktopSeams.fetch = vi.fn(async () => {
      throw new Error("net down");
    }) as unknown as typeof fetch;
    await refreshDesktop();
    const after = desktopSnapshot();
    // The running process's own identity survives — the page is still in it.
    expect(after).toMatchObject({ desktop: true, reachable: false, answered: true, version: "1.26.0", platform: "win32", electron: "33.4.11" });
    // Everything the failed poll did not read does not.
    expect(after.update).toEqual({ state: "unavailable", version: null, percent: null, error: null, checkedAt: null });
    expect(describeUpdate(after.update, after.reachable, after.answered)).toMatch(/stopped answering the update bridge/);
  });

  it("polls only while something is subscribed", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeFetch(() => ({ status: 200, body: shellJson() }));
      desktopSeams.fetch = f;
      const unsub = subscribeDesktop(() => {});
      await vi.advanceTimersByTimeAsync(61_000);
      const seen = (f as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
      expect(seen).toBe(2);
      unsub();
      await vi.advanceTimersByTimeAsync(120_000);
      expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(seen);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("describeUpdate", () => {
  const u = (p: Partial<DesktopUpdate>): DesktopUpdate => ({ state: "idle", version: null, percent: null, error: null, checkedAt: null, ...p });

  it("has a line for every state", () => {
    expect(describeUpdate(u({ state: "unavailable" }), true)).toMatch(/no update feed/);
    expect(describeUpdate(u({ state: "idle" }), true)).toBe("not checked yet");
    expect(describeUpdate(u({ state: "checking" }), true)).toMatch(/checking/);
    expect(describeUpdate(u({ state: "available", version: "1.27.0" }), true)).toBe("1.27.0 found — downloading");
    expect(describeUpdate(u({ state: "downloading", version: "1.27.0", percent: 42 }), true)).toBe("downloading 1.27.0 · 42%");
    expect(describeUpdate(u({ state: "downloading" }), true)).toBe("downloading the update");
    expect(describeUpdate(u({ state: "ready", version: "1.27.0" }), true)).toBe("1.27.0 is downloaded — restart to install it");
    expect(describeUpdate(u({ state: "none" }), true)).toBe("up to date");
    expect(describeUpdate(u({ state: "error", error: "net::ERR_INTERNET_DISCONNECTED" }), true)).toBe(
      "could not reach the release feed — net::ERR_INTERNET_DISCONNECTED",
    );
    expect(describeUpdate(u({ state: "error" }), true)).toBe("could not reach the release feed");
  });

  it("tells a shell that never had the bridge apart from one that stopped answering", () => {
    expect(describeUpdate(u({ state: "ready", version: "1.28.0" }), false)).toMatch(/predates the update bridge/);
    expect(describeUpdate(u({ state: "ready", version: "1.28.0" }), false, true)).toBe(
      "the shell stopped answering the update bridge — the updater's state is unmeasured until it answers again",
    );
  });
});

describe("the update banner's gate", () => {
  const update = (p: Partial<DesktopUpdate>): DesktopUpdate => ({ state: "idle", version: null, percent: null, error: null, checkedAt: null, ...p });
  const QUIET_STATES: DesktopUpdate["state"][] = ["unavailable", "idle", "checking", "available", "downloading", "none", "error"];

  it("only a downloaded update interrupts the reader", () => {
    expect(updateBannerReady(update({ state: "ready", version: "1.28.0" }), null)).toBe(true);
    // Everything before "ready" belongs in Settings → About, not across the
    // top of whatever page the reader is on.
    for (const state of QUIET_STATES) {
      expect(updateBannerReady(update({ state, version: "1.28.0" }), null)).toBe(false);
    }
  });

  it("Later hides that download and no other", () => {
    expect(updateBannerReady(update({ state: "ready", version: "1.28.0" }), "1.28.0")).toBe(false);
    // The whole reason the dismissal stores a version instead of a boolean:
    // a second download announces itself rather than inheriting the first
    // "Later" for the life of the window.
    expect(updateBannerReady(update({ state: "ready", version: "1.29.0" }), "1.28.0")).toBe(true);
  });

  it("a shell that reports ready without a version is still dismissable", () => {
    const nameless = update({ state: "ready" });
    expect(updateBannerVersion(nameless)).toBe("?");
    expect(updateBannerReady(nameless, null)).toBe(true);
    expect(updateBannerReady(nameless, "?")).toBe(false);
    // And dismissing the nameless one does not silence a named one.
    expect(updateBannerReady(update({ state: "ready", version: "1.28.0" }), "?")).toBe(true);
  });

  it("names the version the banner prints", () => {
    expect(updateBannerVersion(update({ state: "ready", version: "1.28.0" }))).toBe("1.28.0");
  });
});
