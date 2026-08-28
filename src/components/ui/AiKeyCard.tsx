"use client";

// Where a reader actually goes looking for an API key.
//
// This started as a 10px chip at the tail of a disclaimer line on the research
// page — visible in the DOM, invisible in practice, and asked about twice
// before anyone found it. A key is a setting; it belongs on the settings page,
// in a panel with a heading, next to the other providers.
//
// The research page keeps its inline version for when the need becomes obvious
// mid-question. Both read and write the same store, so enabling it in one place
// enables it in the other without a reload.

import { useState, useSyncExternalStore } from "react";
import {
  saveAi,
  clearAi,
  looksLikeKey,
  maskKey,
  subscribeAi,
  getAiSnapshot,
  getAiServerSnapshot,
  FREE_MODELS,
} from "@/lib/ai/config";

export function AiKeyCard() {
  const ai = useSyncExternalStore(subscribeAi, getAiSnapshot, getAiServerSnapshot);
  const [draft, setDraft] = useState("");

  return (
    <div className="panel p-3.5 flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="panel-title">Plain-English answers (optional)</span>
        <span className={`chip ${ai.enabled && ai.apiKey ? "chip-pos" : ""}`}>
          {ai.apiKey ? (ai.enabled ? "on" : "key saved, off") : "not set"}
        </span>
      </div>

      <div className="text-[12px] dim leading-relaxed">
        Paste your own{" "}
        <a className="link" href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">
          OpenRouter key
        </a>{" "}
        and a free model will reword answers on the{" "}
        <a className="link" href="/nova/research/">
          Research Desk
        </a>{" "}
        into plain prose. It rewords only — the figures still come from the app, and{" "}
        <b className="text-[var(--text)]">every number the model writes is checked against the evidence</b>; text that
        invents one is discarded and the computed answer stands.
      </div>

      <div className="text-[11px] faint leading-relaxed">
        The key is stored in this browser alone, is sent to openrouter.ai and nowhere else, and never reaches
        romapps.xyz. Every model listed is free tier — no card, no charge.
      </div>

      {ai.apiKey ? (
        <div className="flex items-center gap-2 flex-wrap text-[11.5px]">
          <span className="num chip">{maskKey(ai.apiKey)}</span>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={ai.enabled}
              onChange={() => saveAi({ ...ai, enabled: !ai.enabled })}
              className="accent-[#38e1ff]"
            />
            enabled
          </label>
          <button className="btn text-[11px]" onClick={() => clearAi()}>
            Remove key
          </button>
        </div>
      ) : (
        <>
          <div className="flex gap-2 flex-wrap">
            <input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="sk-or-v1-…"
              spellCheck={false}
              autoComplete="off"
              className="input flex-1 min-w-[240px]"
            />
            <button
              className="btn btn-primary"
              disabled={!looksLikeKey(draft)}
              onClick={() => {
                saveAi({ ...ai, apiKey: draft.trim(), enabled: true });
                setDraft("");
              }}
            >
              Save key
            </button>
          </div>
          {draft !== "" && !looksLikeKey(draft) && (
            <div className="text-[11px] neg">
              OpenRouter keys start with <span className="num">sk-or-v1-</span> — check for surrounding quotes or a
              truncated paste.
            </div>
          )}
        </>
      )}

      <div className="flex items-center gap-2 text-[11.5px]">
        <span className="faint">model</span>
        <select
          value={ai.model}
          onChange={(e) => saveAi({ ...ai, model: e.target.value })}
          className="input flex-1"
        >
          {FREE_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.note}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
