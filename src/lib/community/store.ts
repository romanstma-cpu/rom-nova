"use client";

// Community, on the reader's side: whether to be counted, and the notes.
//
// "I followed" on the copy desk is this browser's record. With a gated
// radar and a signed-in reader it can also become one more in a count
// that every other reader sees on the signal — a number, never a name or
// an amount. That is a choice, remembered here, on by default because a
// count with nobody in it says nothing and off with one click. Notes on a
// tracked wallet are read and written through the radar under a stable
// pseudonym; this store keeps the last read per wallet so a row that
// opens twice does not ask twice.

import { accessToken } from "@/lib/account/auth";
import { deleteNoteRemote, fetchNotes, postFollowShare, postNote, type HostedNote } from "@/lib/account/hosted";

const SHARE_KEY = "whalenova_share_follows_v1";

export interface CommunityState {
  /** count my follows for other readers */
  share: boolean;
  /** notes by wallet, last read */
  notes: Record<string, { rows: HostedNote[]; at: number }>;
  busy: boolean;
  error: string | null;
  /** the last count the radar answered with, by signal key */
  counted: Record<string, number>;
  asOf: number;
}

const SERVER_STATE: CommunityState = { share: true, notes: {}, busy: false, error: null, counted: {}, asOf: 0 };
let state: CommunityState = SERVER_STATE;
let restored = false;
const listeners = new Set<() => void>();

function notify(next: Partial<CommunityState>): void {
  state = { ...state, ...next, asOf: Date.now() };
  for (const l of listeners) l();
}

function ensureRestored(): void {
  if (restored || typeof localStorage === "undefined") return;
  restored = true;
  try {
    const v = localStorage.getItem(SHARE_KEY);
    if (v === "0") state = { ...state, share: false };
  } catch {
    /* no storage: the default stands */
  }
}

export function subscribeCommunity(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function communitySnapshot(): CommunityState {
  ensureRestored();
  return state;
}

export const communityServerSnapshot = (): CommunityState => SERVER_STATE;

/** Tests only. */
export function resetCommunityStore(): void {
  state = SERVER_STATE;
  restored = false;
}

export function setShareFollows(on: boolean): void {
  ensureRestored();
  try {
    localStorage.setItem(SHARE_KEY, on ? "1" : "0");
  } catch {
    /* fine */
  }
  notify({ share: on });
}

type Fetch = typeof fetch;

/** Tell the radar this reader followed a signal. Fire-and-forget from the desk; the count comes back over the socket too. */
export async function shareFollow(url: string, signalKey: string, fetchImpl: Fetch = fetch): Promise<number | null> {
  const token = await accessToken(fetchImpl);
  if (!token) return null;
  try {
    const n = await postFollowShare(url, token, signalKey, fetchImpl);
    notify({ counted: { ...state.counted, [signalKey]: n }, error: null });
    return n;
  } catch (err) {
    notify({ error: err instanceof Error ? err.message : "the radar did not take the follow" });
    return null;
  }
}

export async function loadNotes(url: string, wallet: string, fetchImpl: Fetch = fetch): Promise<HostedNote[] | null> {
  const token = await accessToken(fetchImpl);
  if (!token) return null;
  notify({ busy: true });
  try {
    const rows = await fetchNotes(url, token, wallet, fetchImpl);
    notify({ busy: false, error: null, notes: { ...state.notes, [wallet]: { rows, at: Date.now() } } });
    return rows;
  } catch (err) {
    notify({ busy: false, error: err instanceof Error ? err.message : "could not read the notes" });
    return null;
  }
}

export async function addNote(url: string, wallet: string, body: string, fetchImpl: Fetch = fetch): Promise<HostedNote | null> {
  const token = await accessToken(fetchImpl);
  if (!token) return null;
  notify({ busy: true, error: null });
  try {
    const note = await postNote(url, token, wallet, body, fetchImpl);
    const prev = state.notes[wallet]?.rows ?? [];
    notify({ busy: false, notes: { ...state.notes, [wallet]: { rows: [note, ...prev], at: Date.now() } } });
    return note;
  } catch (err) {
    notify({ busy: false, error: err instanceof Error ? err.message : "the note was not taken" });
    return null;
  }
}

export async function removeNote(url: string, wallet: string, id: string, fetchImpl: Fetch = fetch): Promise<boolean> {
  const token = await accessToken(fetchImpl);
  if (!token) return false;
  notify({ busy: true, error: null });
  try {
    const ok = await deleteNoteRemote(url, token, id, fetchImpl);
    const prev = state.notes[wallet]?.rows ?? [];
    notify({ busy: false, notes: { ...state.notes, [wallet]: { rows: prev.filter((n) => n.id !== id), at: Date.now() } } });
    return ok;
  } catch (err) {
    notify({ busy: false, error: err instanceof Error ? err.message : "the note could not be removed" });
    return false;
  }
}
