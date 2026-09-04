"use client";

// The Helius key, in one card the radar page and the settings page share.
//
// A key is a setting, and a reader who wants to add one goes to Settings
// first — the earlier home for this card was the radar page alone, three
// panels down, where it was a paragraph of setup between the switch and the
// data. Both places render this same component against the same store, so
// a key pasted on either page is live on both without a reload.

import { useState, useSyncExternalStore } from "react";
import {
  heliusKeyValue,
  hunterServerSnapshot,
  hunterSnapshot,
  looksLikeHeliusKey,
  maskHeliusKey,
  setHeliusKey,
  subscribeHunter,
} from "@/lib/radar/hunter";

export function HeliusKeyCard({ compact = false }: { compact?: boolean }) {
  const hunter = useSyncExternalStore(subscribeHunter, hunterSnapshot, hunterServerSnapshot);
  const helius = hunter.helius;
  const [draft, setDraft] = useState("");

  return (
    <div className="panel p-3.5 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="panel-title">Helius key · optional</span>
        <span className={`chip text-[9.5px] ${helius.active && helius.connected ? "chip-pos" : ""}`}>
          {helius.active
            ? helius.connected
              ? `extending · following ${helius.following}`
              : "key set · not connected"
            : helius.keySet
              ? "saved · used while the radar is armed"
              : "not set"}
        </span>
        {helius.active && helius.txErrors > 0 && (
          <span className="chip chip-danger text-[9.5px]">{helius.txErrors} read errors</span>
        )}
      </div>
      <div className="text-[11.5px] dim leading-relaxed">
        The keyless stream goes blind once a token leaves the bonding curve. A free{" "}
        <a className="link" href="https://dashboard.helius.dev" target="_blank" rel="noopener noreferrer">
          Helius key
        </a>{" "}
        lets the Whale Radar keep following its top wallets on every venue, so a proven wallet&apos;s record keeps
        growing after graduation.
        {!compact && (
          <>
            {" "}
            The key stays in this browser and is sent to helius-rpc.com and nowhere else; in Helius&apos;s dashboard you
            can restrict which sites may use it.
          </>
        )}
      </div>
      {helius.active && !helius.connected && (
        <div className="text-[11px] warn">
          Helius has not accepted the key yet. A key it rejects stays here — re-check the paste.
        </div>
      )}
      {helius.keySet ? (
        <div className="flex items-center gap-2 flex-wrap text-[11.5px]">
          <span className="num chip">{maskHeliusKey(heliusKeyValue())}</span>
          {helius.active && (
            <span className="num text-[10.5px] faint">
              {helius.txFetches} tx reads · {helius.offCurveFills} off-curve fills journaled
            </span>
          )}
          <button type="button" className="btn text-[11px]" onClick={() => setHeliusKey("")}>
            Remove key
          </button>
        </div>
      ) : (
        <div className="flex gap-2 flex-wrap">
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            spellCheck={false}
            autoComplete="off"
            className="input num text-[12px] flex-1 min-w-[240px]"
            aria-label="Helius API key"
          />
          <button
            type="button"
            className="btn btn-primary text-[11px]"
            disabled={!looksLikeHeliusKey(draft)}
            onClick={() => {
              setHeliusKey(draft);
              setDraft("");
            }}
          >
            SAVE KEY
          </button>
        </div>
      )}
      {draft !== "" && !looksLikeHeliusKey(draft) && (
        <div className="text-[11px] neg">
          Helius keys look like a UUID (8-4-4-4-12 hex) — copy it from your Helius dashboard, without quotes.
        </div>
      )}
    </div>
  );
}
