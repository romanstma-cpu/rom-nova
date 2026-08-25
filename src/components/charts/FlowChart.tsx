"use client";

// Whale-flow chart: buy/sell histograms with smart-money net line and an
// optional price overlay. lightweight-charts v5.

import { useEffect, useRef } from "react";
import {
  createChart,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { FlowPoint } from "@/lib/api/rows";

export function FlowChart({ flow, height = 220, showPrice = false }: { flow: FlowPoint[]; height?: number; showPrice?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

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
    chartRef.current = chart;

    const quiet = { lastValueVisible: false, priceLineVisible: false } as const;
    const buys = chart.addSeries(HistogramSeries, { color: "rgba(46,230,168,0.55)", priceFormat: { type: "volume" }, ...quiet });
    const sells = chart.addSeries(HistogramSeries, { color: "rgba(255,77,109,0.55)", priceFormat: { type: "volume" }, ...quiet });
    const sm = chart.addSeries(LineSeries, { color: "#38e1ff", lineWidth: 2, priceFormat: { type: "volume" }, ...quiet });

    buys.setData(flow.map((p) => ({ time: (p.ts / 1000) as UTCTimestamp, value: p.whaleBuyUsd })));
    sells.setData(flow.map((p) => ({ time: (p.ts / 1000) as UTCTimestamp, value: -p.whaleSellUsd })));
    sm.setData(flow.map((p) => ({ time: (p.ts / 1000) as UTCTimestamp, value: p.smNetUsd })));

    if (showPrice) {
      const price = chart.addSeries(LineSeries, {
        color: "rgba(139,124,255,0.9)",
        lineWidth: 1,
        priceScaleId: "price",
        priceFormat: { type: "price", precision: 8, minMove: 1e-8 },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale("price").applyOptions({ scaleMargins: { top: 0.05, bottom: 0.6 } });
      price.setData(flow.filter((p) => p.priceUsd > 0).map((p) => ({ time: (p.ts / 1000) as UTCTimestamp, value: p.priceUsd })));
    }

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [flow, height, showPrice]);

  return <div ref={ref} style={{ height }} className="w-full" />;
}
