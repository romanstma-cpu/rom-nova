"use client";

// One computed answer, optionally reworded.
//
// Used by the Research Desk and by the token page's inline questions, so the
// rule holds identically in both: the engine's answer is always shown, a model
// may add a second phrasing above it, and any number the model invents throws
// the whole rewording away.
//
// Written as a component rather than repeated because the two hosts had begun
// to diverge — one showed evidence rows, the other did not, and only one had
// any narration at all.

import { useState } from "react";
import { narrate, type Evidence } from "@/lib/ai/narrate";
import type { AiSettings } from "@/lib/ai/config";

export interface ComputedAnswer {
  question: string;
  answer: string;
  evidence: Evidence[];
}

export function NarratedAnswer({
  answer,
  ai,
  compact = false,
}: {
  answer: ComputedAnswer;
  ai: AiSettings;
  /** The token page has less room than the research desk. */
  compact?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = ai.enabled && ai.apiKey !== "";

  async function run() {
    setBusy(true);
    setNote(null);
    const out = await narrate(answer, {
      apiKey: ai.apiKey,
      model: ai.model,
      referer: typeof location === "undefined" ? undefined : location.origin,
      title: "ROM Nova",
    });
    if (out.ok) setText(out.text);
    else setNote(out.reason);
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-1.5">
      {text && <div className="text-[13px] leading-relaxed">{text}</div>}
      <div className={`${text ? "text-[11.5px] dim" : compact ? "text-[11.5px]" : "text-[13px]"} leading-relaxed`}>
        {answer.answer}
      </div>

      {answer.evidence.length > 0 && (
        <div className={`space-y-1 ${compact ? "" : "mt-1.5 border-t border-[var(--border)] pt-2"}`}>
          {answer.evidence.slice(0, compact ? 4 : 8).map((e, i) => (
            <div key={i} className="flex justify-between gap-3 num text-[10.5px]">
              <span className="faint">{e.label}</span>
              <span className="text-right">{e.value}</span>
            </div>
          ))}
        </div>
      )}

      {ready && (
        <div className="flex items-center gap-2 mt-0.5">
          <button className="chip cursor-pointer text-[10px]" onClick={() => void run()} disabled={busy}>
            {busy ? "rewording…" : text ? "reword again" : "say it in plain English"}
          </button>
          {text && <span className="chip chip-pos text-[9.5px]">reworded · figures checked</span>}
        </div>
      )}
      {note && <div className="text-[10px] faint">AI phrasing skipped — {note}</div>}
    </div>
  );
}
