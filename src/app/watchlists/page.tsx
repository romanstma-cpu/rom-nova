"use client";

import { useState } from "react";
import Link from "next/link";
import { useApi, apiPost, fmtUsd, shortAddr } from "@/lib/client";
import { Empty } from "@/components/ui/bits";

interface WlItem {
  kind: "token" | "wallet";
  ref: string;
  addedAt: number;
  symbol?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  entity?: string;
  smartMoneyScore?: number;
  realizedPnlUsd?: number;
}

interface Wl {
  id: string;
  name: string;
  items: WlItem[];
}

export default function WatchlistsPage() {
  const { data, reload } = useApi<{ watchlists: Wl[] }>("/api/watchlists", 15_000);
  const [name, setName] = useState("");
  const [addRef, setAddRef] = useState<Record<string, string>>({});

  const post = async (body: unknown) => {
    const res = await apiPost("/api/watchlists", body);
    reload();
    return res;
  };

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h1 className="text-[15px] font-semibold tracking-wide">WATCHLISTS</h1>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="new list name" className="input w-[200px] ml-auto" />
        <button
          className="btn btn-primary"
          onClick={() => {
            if (name.trim()) {
              post({ op: "create", name: name.trim() });
              setName("");
            }
          }}
        >
          Create
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {(data?.watchlists ?? []).map((wl) => (
          <div key={wl.id} className="panel">
            <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
              <span className="panel-title">{wl.name} · {wl.items.length}</span>
              <button className="chip chip-neg cursor-pointer" onClick={() => post({ op: "delete", id: wl.id })}>delete list</button>
            </div>
            {wl.items.map((it) => (
              <div key={it.ref} className="px-3 py-1.5 border-b border-[rgba(27,35,51,0.5)] flex items-center gap-2 text-[12px] num">
                <Link href={it.kind === "token" ? `/token?m=${it.ref}` : `/whale?a=${it.ref}`} className="hover:text-[var(--accent)] flex-1 truncate">
                  {it.kind === "token" ? (
                    <>
                      <span style={{ fontFamily: "var(--font-sans)" }}>{it.symbol ?? shortAddr(it.ref)}</span>
                      <span className="faint ml-2">{fmtUsd(it.priceUsd)} · mcap {fmtUsd(it.marketCapUsd)}</span>
                    </>
                  ) : (
                    <>
                      <span style={{ fontFamily: "var(--font-sans)" }}>{it.entity ?? shortAddr(it.ref)}</span>
                      <span className="faint ml-2">SM {it.smartMoneyScore} · realized {fmtUsd(it.realizedPnlUsd)}</span>
                    </>
                  )}
                </Link>
                <span className="chip">{it.kind}</span>
                <button className="faint hover:text-[var(--neg)]" onClick={() => post({ op: "remove", id: wl.id, ref: it.ref })}>✕</button>
              </div>
            ))}
            <div className="px-3 py-2 flex gap-2">
              <input
                value={addRef[wl.id] ?? ""}
                onChange={(e) => setAddRef((m) => ({ ...m, [wl.id]: e.target.value }))}
                placeholder="mint or wallet address"
                className="input flex-1"
              />
              <button
                className="btn text-[11px]"
                onClick={async () => {
                  const ref = (addRef[wl.id] ?? "").trim();
                  if (!ref) return;
                  const asToken = await post({ op: "add", id: wl.id, kind: "token", ref });
                  if (!asToken.ok) await post({ op: "add", id: wl.id, kind: "wallet", ref });
                  setAddRef((m) => ({ ...m, [wl.id]: "" }));
                }}
              >
                add
              </button>
            </div>
          </div>
        ))}
      </div>
      {(data?.watchlists ?? []).length === 0 && <Empty>No lists yet.</Empty>}
    </div>
  );
}
