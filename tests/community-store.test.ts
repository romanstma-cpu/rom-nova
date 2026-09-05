// The reader's side of community: the remembered choice to be counted,
// the follow that becomes a number, and notes read and written through
// the radar.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, headerOf, jsonOf } from "./helpers/worker-config";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  },
});

const RADAR = "https://radar.example";
const AUTH = "https://proj.supabase.co";
const NOW = 1_788_000_000_000;
const W = "So11111111111111111111111111111111111111112";
const KEY = `${W}:${W}:2026-09-05T00:00:00.000Z`;

function signedIn() {
  store.set(
    "whalenova_account_v1",
    JSON.stringify({ accessToken: "tok", refreshToken: "r", expiresAt: NOW + 3_600_000, user: { id: "user-1", email: "r@x.y" }, auth: { url: AUTH, anonKey: "anon-1" } }),
  );
}

async function fresh() {
  const a = await import("../src/lib/account/auth");
  a.resetAccountStore();
  const c = await import("../src/lib/community/store");
  c.resetCommunityStore();
  return c;
}

describe("community store", () => {
  // The fake session expires an hour after NOW; the clock must agree.
  beforeEach(() => {
    store.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts the reader by default and remembers the choice not to", async () => {
    const c = await fresh();
    expect(c.communitySnapshot().share).toBe(true);
    c.setShareFollows(false);
    expect(c.communitySnapshot().share).toBe(false);
    expect(store.get("whalenova_share_follows_v1")).toBe("0");
    const again = await fresh();
    expect(again.communitySnapshot().share).toBe(false);
  });

  it("posts a follow with the session and keeps the count the radar answered", async () => {
    signedIn();
    const c = await fresh();
    const radar = fakeFetch((url, init) => (url === `${RADAR}/api/v1/follows` && init?.method === "POST" ? { status: 201, body: { signal_key: KEY, followers: 4 } } : { status: 404, body: {} }));
    expect(await c.shareFollow(RADAR, KEY, radar.fetchImpl)).toBe(4);
    expect(headerOf(radar.calls[0], "authorization")).toBe("Bearer tok");
    expect(jsonOf(radar.calls[0])).toEqual({ signal_key: KEY });
    expect(c.communitySnapshot().counted[KEY]).toBe(4);
    const off = await fresh();
    expect(await off.shareFollow(RADAR, KEY, radar.fetchImpl)).toBe(4);
  });

  it("does nothing signed out, and names a refusal", async () => {
    const c = await fresh();
    const radar = fakeFetch(() => ({ status: 500, body: {} }));
    expect(await c.shareFollow(RADAR, KEY, radar.fetchImpl)).toBeNull();
    expect(radar.calls).toHaveLength(0);
    signedIn();
    const c2 = await fresh();
    const refusing = fakeFetch(() => ({ status: 503, body: { error: "community is not set up on this radar yet" } }));
    expect(await c2.shareFollow(RADAR, KEY, refusing.fetchImpl)).toBeNull();
    expect(c2.communitySnapshot().error).toMatch(/not set up/);
  });

  it("reads, adds and removes notes for a wallet through the radar", async () => {
    signedIn();
    const c = await fresh();
    const notes: Record<string, unknown>[] = [{ id: "11111111-1111-4111-8111-111111111111", handle: "reader-abc123", body: "old", created_at: "2026-09-05T00:00:00Z", mine: false }];
    const radar = fakeFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (url === `${RADAR}/api/v1/wallets/${W}/notes` && method === "GET") return { status: 200, body: { notes } };
      if (url === `${RADAR}/api/v1/wallets/${W}/notes` && method === "POST") return { status: 201, body: { id: "22222222-2222-4222-8222-222222222222", handle: "reader-me0000", body: jsonOf({ url, init }).body, created_at: "2026-09-05T01:00:00Z", mine: true } };
      if (url.startsWith(`${RADAR}/api/v1/notes/`) && method === "DELETE") return { status: 200, body: { deleted: url.split("/").pop() } };
      return { status: 404, body: {} };
    });
    expect(await c.loadNotes(RADAR, W, radar.fetchImpl)).toHaveLength(1);
    const added = await c.addNote(RADAR, W, "sells into every pump", radar.fetchImpl);
    expect(added).toMatchObject({ body: "sells into every pump", mine: true });
    expect(c.communitySnapshot().notes[W].rows.map((n) => n.id)).toEqual(["22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"]);
    expect(await c.removeNote(RADAR, W, "22222222-2222-4222-8222-222222222222", radar.fetchImpl)).toBe(true);
    expect(c.communitySnapshot().notes[W].rows).toHaveLength(1);
    expect(radar.calls.at(-1)?.url).toBe(`${RADAR}/api/v1/notes/22222222-2222-4222-8222-222222222222`);
  });
});
