"use client";

// Notes on a tracked wallet, from the readers of the connected radar.
//
// Read and written through the radar, under a pseudonym the radar derives
// from the reader's id — stable enough that one reader's notes hang
// together, useless for finding out who they are. Short on purpose, three
// per reader per wallet, and the operator can hide one. What a note says
// is one reader's opinion; the numbers beside it are the radar's.

import { useEffect, useState, useSyncExternalStore } from "react";
import { addNote, communityServerSnapshot, communitySnapshot, loadNotes, removeNote, subscribeCommunity } from "@/lib/community/store";

const NOTE_MAX = 280;
const fmtWhen = (iso: string | null): string => {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
};

export function WalletNotes({ url, wallet }: { url: string; wallet: string }) {
  const community = useSyncExternalStore(subscribeCommunity, communitySnapshot, communityServerSnapshot);
  const [draft, setDraft] = useState("");
  const cached = community.notes[wallet];

  useEffect(() => {
    if (!communitySnapshot().notes[wallet]) void loadNotes(url, wallet);
  }, [url, wallet]);

  const rows = cached?.rows ?? null;
  const left = NOTE_MAX - draft.length;

  return (
    <div className="panel p-2.5 flex flex-col gap-1.5 text-[11px]">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="panel-title">Reader notes</span>
        <span className="faint">{rows ? `${rows.length} note${rows.length === 1 ? "" : "s"}` : "reading…"}</span>
        <span className="faint ml-auto">pseudonymous · three per reader per wallet · the operator can hide one</span>
      </div>
      {rows && rows.length === 0 && <div className="faint">Nothing yet. What do you know about this wallet that the numbers do not say?</div>}
      {rows &&
        rows.map((n) => (
          <div key={n.id} className="flex items-baseline gap-2 flex-wrap border-t border-[rgba(27,35,51,0.5)] pt-1">
            <span className={`num text-[10px] ${n.mine ? "text-[var(--accent)]" : "dim"}`}>{n.mine ? "you" : n.handle}</span>
            <span className="min-w-0 break-words">{n.body}</span>
            <span className="faint num text-[9.5px] ml-auto">{fmtWhen(n.created_at)}</span>
            {n.mine && (
              <button type="button" className="text-[9.5px] link" disabled={community.busy} onClick={() => void removeNote(url, wallet, n.id)}>
                remove
              </button>
            )}
          </div>
        ))}
      <form
        className="flex items-start gap-2 flex-wrap pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          void addNote(url, wallet, draft).then((n) => {
            if (n) setDraft("");
          });
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, NOTE_MAX))}
          rows={2}
          placeholder="a short note for other readers — what this wallet does, not what to buy"
          className="input text-[11px] flex-1 min-w-[220px] resize-y"
          aria-label="Note on this wallet"
        />
        <div className="flex flex-col gap-1 items-end">
          <button type="submit" className="btn btn-primary text-[10px]" disabled={community.busy || !draft.trim()}>
            POST NOTE
          </button>
          <span className={`num text-[9.5px] ${left < 20 ? "warn" : "faint"}`}>{left}</span>
        </div>
      </form>
      {community.error && <div className="text-[var(--danger)]">{community.error}</div>}
    </div>
  );
}
