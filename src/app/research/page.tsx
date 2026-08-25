"use client";

import { useState } from "react";
import Link from "next/link";
import { useApi, apiPost, fmtPct, fmtAgo } from "@/lib/client";
import { Empty } from "@/components/ui/bits";

interface Answer {
  question: string;
  answer: string;
  evidence: { label: string; value: string }[];
  sources: { name: string; ts: number }[];
  links: { label: string; href: string }[];
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

  const ask = async (question: string) => {
    setBusy(true);
    setQ("");
    try {
      const res = await apiPost<Answer>("/api/research/ask", { question });
      if (res.ok) setThread((t) => [res.body, ...t]);
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
          <div className="text-[10px] faint mt-2">
            Answers are built from structured queries against the app database — every claim carries its evidence and source timestamp. No generative model is involved.
          </div>
        </div>

        {thread.map((a, i) => (
          <div key={i} className="panel p-3.5 fade-up">
            <div className="text-[11px] faint mb-1.5">Q · {a.question}</div>
            <div className="text-[13px] leading-relaxed">{a.answer}</div>
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
