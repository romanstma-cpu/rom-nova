"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useApi, apiPost, fmtPct, fmtAgo } from "@/lib/client";
import { Empty } from "@/components/ui/bits";
import { narrate } from "@/lib/ai/narrate";
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

interface Answer {
  question: string;
  answer: string;
  evidence: { label: string; value: string }[];
  sources: { name: string; ts: number }[];
  links: { label: string; href: string }[];
  /** Model phrasing of the same facts, when a key is configured and it passed the checks. */
  narrated?: string;
  /** Why phrasing was not used, so a silent fallback is never mistaken for a working one. */
  narrationNote?: string;
}

interface Note {
  id: string;
  mint: string;
  symbol: string;
  ts: number;
  note: string;
  outcomePct: number;
}

const SUGGESTIONS = [
  "What changed in the last hour?",
  "Which tokens have smart money accumulating right now?",
  "Show me the biggest whale exits today",
];

export default function ResearchPage() {
  const [q, setQ] = useState("");
  const [thread, setThread] = useState<Answer[]>([]);
  const [busy, setBusy] = useState(false);
  const { data: notes, reload } = useApi<{ notes: Note[] }>("/api/research");
  const [noteMint, setNoteMint] = useState("");
  const [noteText, setNoteText] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [showAi, setShowAi] = useState(false);
  const ai = useSyncExternalStore(subscribeAi, getAiSnapshot, getAiServerSnapshot);

  const ask = async (question: string) => {
    setBusy(true);
    setQ("");
    try {
      const res = await apiPost<Answer>("/api/research/ask", { question });
      if (!res.ok) return;
      const base = res.body;
      // The computed answer goes up immediately. Phrasing is a second pass that
      // can only ever replace the prose, never the evidence beneath it, so a
      // slow or failing model costs presentation and never the answer.
      setThread((t) => [base, ...t]);
      if (!ai.enabled || !ai.apiKey) return;

      const out = await narrate(
        { question: base.question, answer: base.answer, evidence: base.evidence },
        {
          apiKey: ai.apiKey,
          model: ai.model,
          referer: typeof location === "undefined" ? undefined : location.origin,
          title: "ROM Nova",
        },
      );
      setThread((t) =>
        t.map((a) => (a === base ? (out.ok ? { ...a, narrated: out.text } : { ...a, narrationNote: out.reason }) : a)),
      );
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async () => {
    if (!noteMint.trim() || !noteText.trim()) return;
    await apiPost("/api/research", { mint: noteMint.trim(), note: noteText.trim() });
    setNoteMint("");
    setNoteText("");
    reload();
  };

  return (
    <div className="p-3 grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-3">
      <div className="flex flex-col gap-3">
        <h1 className="text-[15px] font-semibold tracking-wide">RESEARCH DESK</h1>
        <div className="panel p-3">
          <div className="flex gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && q.trim() && ask(q.trim())}
              placeholder='Ask the data — "why is TOKEN rising", "who is buying X", "biggest exits today"…'
              className="input flex-1"
            />
            <button className="btn btn-primary" disabled={busy || !q.trim()} onClick={() => ask(q.trim())}>
              {busy ? "…" : "Ask"}
            </button>
          </div>
          <div className="flex gap-2 mt-2 flex-wrap">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip cursor-pointer hover:border-[var(--accent)]" onClick={() => ask(s)}>{s}</button>
            ))}
          </div>
          <div className="text-[10px] faint mt-2 flex items-center justify-between gap-3 flex-wrap">
            <span>
              Answers are built from structured queries against the app database — every claim carries its
              evidence and source timestamp.{" "}
              {ai.enabled ? "A model rewords them; it never supplies a number." : "No generative model is involved."}
            </span>
            {/* Was 10px grey at the tail of this line — present in the DOM and
                invisible in practice. Given the accent colour and a size that
                reads as a control, since it is one. */}
            <button
              className={`chip cursor-pointer shrink-0 text-[11px] ${ai.enabled ? "chip-pos" : "chip-accent"}`}
              onClick={() => setShowAi((v) => !v)}
            >
              {ai.enabled ? "AI phrasing: on" : "Add an AI key"}
            </button>
          </div>

          {showAi && (
            <div className="mt-2.5 border-t border-[var(--border)] pt-2.5 text-[11.5px] space-y-2">
              <div className="dim leading-relaxed">
                Optional. Paste your own{" "}
                <a
                  className="text-[var(--accent)]"
                  href="https://openrouter.ai/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  OpenRouter key
                </a>{" "}
                to have a free model reword each answer. The key is stored in this browser only, is sent to
                openrouter.ai and nowhere else, and every number the model writes is checked against the
                evidence — invented figures are discarded and the computed answer stands.
              </div>

              {ai.apiKey ? (
                <div className="flex items-center gap-2 flex-wrap">
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
                  <button
                    className="btn text-[11px]"
                    onClick={() => {
                      clearAi();
                      setKeyDraft("");
                    }}
                  >
                    Remove key
                  </button>
                </div>
              ) : (
                <div className="flex gap-2 flex-wrap">
                  <input
                    type="password"
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    placeholder="sk-or-v1-…"
                    spellCheck={false}
                    autoComplete="off"
                    className="input flex-1 min-w-[220px]"
                  />
                  <button
                    className="btn btn-primary"
                    disabled={!looksLikeKey(keyDraft)}
                    onClick={() => {
                      saveAi({ ...ai, apiKey: keyDraft.trim(), enabled: true });
                      setKeyDraft("");
                    }}
                  >
                    Save
                  </button>
                </div>
              )}
              {keyDraft !== "" && !looksLikeKey(keyDraft) && (
                <div className="text-[10.5px] neg">
                  That does not look like an OpenRouter key — they start with{" "}
                  <span className="num">sk-or-v1-</span>. Check for surrounding quotes or a truncated paste.
                </div>
              )}

              <div className="flex items-center gap-2">
                <span className="faint">model</span>
                <select
                  value={ai.model}
                  onChange={(e) => saveAi({ ...ai, model: e.target.value })}
                  className="input flex-1 text-[11.5px]"
                >
                  {FREE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.note}
                    </option>
                  ))}
                </select>
              </div>
              <div className="faint text-[10px]">
                Every listed model is free tier on OpenRouter — no card, no charge.
              </div>
            </div>
          )}
        </div>

        {thread.map((a, i) => (
          <div key={i} className="panel p-3.5 fade-up">
            <div className="text-[11px] faint mb-1.5">Q · {a.question}</div>
            {/* The reworded version sits ABOVE the computed answer, never in
                place of it. Both are shown because the second is what the first
                was made from, and a reader deserves to be able to check. */}
            {a.narrated && (
              <div className="text-[13px] leading-relaxed mb-2">
                {a.narrated}
                <span className="chip chip-pos ml-2 align-middle text-[9.5px]">reworded · figures checked</span>
              </div>
            )}
            <div className={`leading-relaxed ${a.narrated ? "text-[12px] dim" : "text-[13px]"}`}>{a.answer}</div>
            {a.narrationNote && (
              <div className="text-[10px] faint mt-1">AI phrasing skipped — {a.narrationNote}</div>
            )}
            {a.evidence.length > 0 && (
              <div className="mt-2.5 border-t border-[var(--border)] pt-2 space-y-1">
                {a.evidence.map((e, j) => (
                  <div key={j} className="flex justify-between gap-3 text-[11.5px] num">
                    <span className="dim">{e.label}</span>
                    <span className="text-right">{e.value}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2 mt-2.5 flex-wrap">
              {a.links.map((l, j) => (
                <Link key={j} href={l.href} className="chip chip-accent cursor-pointer">{l.label} →</Link>
              ))}
            </div>
            <div className="text-[9.5px] faint mt-2 num">
              sources: {a.sources.map((s) => `${s.name} @ ${new Date(s.ts).toLocaleTimeString()}`).join(", ")}
            </div>
          </div>
        ))}
        {thread.length === 0 && <Empty>Ask a question — the desk queries signals, flows, wallets and events directly.</Empty>}
      </div>

      {/* journal */}
      <div className="flex flex-col gap-3">
        <div className="panel p-3">
          <div className="panel-title mb-2">Research journal · save an investigation</div>
          <input value={noteMint} onChange={(e) => setNoteMint(e.target.value)} placeholder="token mint" className="input w-full mb-2" />
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="thesis, levels, what would invalidate it…"
            className="input w-full h-[70px] resize-none"
          />
          <button className="btn btn-primary w-full justify-center mt-2" onClick={saveNote}>Save with market snapshot</button>
        </div>
        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">Journal · outcome since saved</div>
          {(notes?.notes ?? []).map((n) => (
            <Link key={n.id} href={`/token?m=${n.mint}`} className="block px-3 py-2 border-b border-[rgba(27,35,51,0.5)] hover:bg-[rgba(40,55,85,0.15)]">
              <div className="flex items-center justify-between">
                <span className="text-[12.5px] font-semibold">{n.symbol}</span>
                <span className={`num text-[11.5px] ${n.outcomePct >= 0 ? "pos" : "neg"}`}>{fmtPct(n.outcomePct)}</span>
              </div>
              <div className="text-[11px] dim mt-0.5 line-clamp-2">{n.note}</div>
              <div className="text-[9.5px] faint mt-0.5 num">{fmtAgo(n.ts)}</div>
            </Link>
          ))}
          {(notes?.notes ?? []).length === 0 && <Empty>No saved investigations yet.</Empty>}
        </div>
      </div>
    </div>
  );
}
