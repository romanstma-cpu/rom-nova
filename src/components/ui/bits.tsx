"use client";

// Small shared UI atoms: score bars, risk badges, freshness tags, sparklines.

import { fmtAgo, scoreColor } from "@/lib/client";

export function Score({ value, width = 64 }: { value: number; width?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="num text-[12.5px]" style={{ color: scoreColor(value) }}>
        {value}
      </span>
      <span className="scorebar" style={{ width }}>
        <div style={{ width: `${value}%`, background: scoreColor(value) }} />
      </span>
    </span>
  );
}

export function RiskBadge({ level }: { level: "low" | "medium" | "high" }) {
  const cls = level === "high" ? "chip-neg" : level === "medium" ? "chip-warn" : "chip-pos";
  return <span className={`chip ${cls}`}>{level}</span>;
}

export function Freshness({ ts }: { ts: number }) {
  return (
    <span className="faint text-[10px] num" title={new Date(ts).toISOString()}>
      updated {fmtAgo(ts)}
    </span>
  );
}

export function TokenMark({ hue, symbol, size = 22 }: { hue: number; symbol: string; size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-semibold select-none shrink-0"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        background: `linear-gradient(135deg, hsl(${hue} 70% 22%), hsl(${(hue + 40) % 360} 80% 38%))`,
        border: `1px solid hsl(${hue} 70% 45% / 0.5)`,
        color: `hsl(${hue} 90% 82%)`,
      }}
    >
      {symbol.slice(0, 2)}
    </span>
  );
}

export function Sparkline({
  values,
  width = 110,
  height = 28,
  color,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (values.length < 2) return <span className="faint text-[10px]">no history</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`);
  const rising = values[values.length - 1] >= values[0];
  const stroke = color ?? (rising ? "var(--pos)" : "var(--neg)");
  return (
    <svg width={width} height={height} className="shrink-0">
      <polyline points={pts.join(" ")} fill="none" stroke={stroke} strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
}

export function Stat({ label, children, sub }: { label: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="panel stat px-3.5 py-2.5 min-w-0">
      <div className="panel-title">{label}</div>
      <div className="num text-[17px] mt-1 truncate">{children}</div>
      {sub && <div className="text-[10.5px] faint mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-8 text-center faint text-[12px]">{children}</div>;
}
