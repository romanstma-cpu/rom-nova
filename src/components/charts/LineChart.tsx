"use client";

// Minimal line/area chart for series like holders or liquidity.

import { useEffect, useRef } from "react";
import { createChart, AreaSeries, type UTCTimestamp } from "lightweight-charts";

export function LineChart({
  points,
  height = 160,
  color = "#38e1ff",
  format = "volume",
}: {
  points: { ts: number; value: number }[];
  height?: number;
  color?: string;
  format?: "volume" | "price";
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      height,
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#8593ab", fontSize: 10, attributionLogo: false },
      grid: { vertLines: { color: "rgba(88,110,160,0.06)" }, horzLines: { color: "rgba(88,110,160,0.06)" } },
      rightPriceScale: { borderColor: "#1b2333" },
      timeScale: { borderColor: "#1b2333", timeVisible: true },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: color,
      topColor: `${color}33`,
      bottomColor: "transparent",
      lineWidth: 2,
      priceFormat: format === "volume" ? { type: "volume" } : { type: "price", precision: 8, minMove: 1e-8 },
      priceLineVisible: false,
    });
    series.setData(points.map((p) => ({ time: (p.ts / 1000) as UTCTimestamp, value: p.value })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, height, color, format]);

  return <div ref={ref} style={{ height }} className="w-full" />;
}
