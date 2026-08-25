"use client";

import { useState } from "react";
import Link from "next/link";
import { useApi, apiPost, fmtAgo } from "@/lib/client";
import { Empty } from "@/components/ui/bits";
import type { AlertEvent, AlertRule } from "@/lib/types";

export default function AlertsPage() {
  const { data, reload } = useApi<{ rules: AlertRule[]; events: AlertEvent[] }>("/api/alerts", 8000);
  const [name, setName] = useState("");
  const [type, setType] = useState("whale_buy");
  const [threshold, setThreshold] = useState("50000");

  const post = async (body: unknown) => {
    await apiPost("/api/alerts", body);
    reload();
  };

  const create = () => {
    const t = Number(threshold) || 0;
    const condition =
      type === "whale_buy" ? { type, minUsd: t }
      : type === "whale_sell" ? { type, minUsd: t }
      : type === "signal_score_above" ? { type, threshold: Math.min(100, t) }
      : { type: "volume_spike", multiple: Math.max(1, t) };
    post({ op: "create", name: name || `${type.replace(/_/g, " ")} ≥ ${threshold}`, condition });
    setName("");
  };

  const unread = (data?.events ?? []).filter((e) => !e.read).length;

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h1 className="text-[15px] font-semibold tracking-wide">ALERT CENTER</h1>
        {unread > 0 && <span className="chip chip-accent">{unread} unread</span>}
        <button className="btn ml-auto text-[11px]" onClick={() => post({ op: "mark_read" })}>mark all read</button>
      </div>

      <div className="panel p-3 flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1">
          <span className="panel-title">Rule name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" className="input w-[200px]" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="panel-title">Condition</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className="input">
            <option value="whale_buy">Whale buy ≥ $</option>
            <option value="whale_sell">Whale sell ≥ $</option>
            <option value="signal_score_above">Signal score ≥</option>
            <option value="volume_spike">Volume spike ×</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="panel-title">Threshold</span>
          <input value={threshold} onChange={(e) => setThreshold(e.target.value)} className="input w-[110px]" />
        </label>
        <button className="btn btn-primary" onClick={create}>Create alert</button>
        <span className="faint text-[10.5px] pb-1.5">delivery: in-app (webhook/email adapters are provider-gated in settings)</span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-3">
        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">Rules</div>
          {(data?.rules ?? []).map((r) => (
            <div key={r.id} className="px-3 py-2 border-b border-[rgba(27,35,51,0.5)] flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] truncate">{r.name}</div>
                <div className="text-[10.5px] faint num">{JSON.stringify(r.condition)}</div>
              </div>
              <button className={`chip cursor-pointer ${r.enabled ? "chip-pos" : ""}`} onClick={() => post({ op: "toggle", id: r.id })}>
                {r.enabled ? "on" : "off"}
              </button>
              <button className="chip chip-neg cursor-pointer" onClick={() => post({ op: "delete", id: r.id })}>✕</button>
            </div>
          ))}
          {(data?.rules ?? []).length === 0 && <Empty>No rules yet.</Empty>}
        </div>

        <div className="panel">
          <div className="panel-title px-3 pt-2.5 pb-1">Fired alerts</div>
          <div className="max-h-[520px] overflow-y-auto">
            {(data?.events ?? []).map((e) => (
              <Link
                key={e.id}
                href={e.mint ? `/token?m=${e.mint}` : "#"}
                className={`block px-3 py-2 border-b border-[rgba(27,35,51,0.5)] hover:bg-[rgba(40,55,85,0.15)] ${e.read ? "opacity-55" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold tracking-wide text-[var(--accent)]">{e.headline}</span>
                  <span className="num text-[10px] faint">{fmtAgo(e.ts)}</span>
                </div>
                <div className="text-[11.5px] dim mt-0.5">{e.detail}</div>
              </Link>
            ))}
            {(data?.events ?? []).length === 0 && <Empty>Nothing fired yet — the live feed evaluates rules continuously.</Empty>}
          </div>
        </div>
      </div>
    </div>
  );
}
