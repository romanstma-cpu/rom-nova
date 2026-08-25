"use client";

// Candlestick + volume chart on lightweight-charts v5, with optional
// trade/signal markers. Updates in place on live ticks.

import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@/lib/types";

export interface ChartMarker {
  ts: number;
  kind: "whale_buy" | "whale_sell" | "smart_buy" | "smart_sell" | "signal";
  text: string;
}

export function PriceChart({
  candles,
  markers = [],
  height = 340,
  livePrice,
}: {
  candles: Candle[];
  markers?: ChartMarker[];
  height?: number;
  livePrice?: { ts: number; price: number } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      height,
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#8593ab",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(88,110,160,0.07)" },
        horzLines: { color: "rgba(88,110,160,0.07)" },
      },
      rightPriceScale: { borderColor: "#1b2333" },
      timeScale: { borderColor: "#1b2333", timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { labelBackgroundColor: "#1b2333" }, vertLine: { labelBackgroundColor: "#1b2333" } },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#2ee6a8",
      downColor: "#ff4d6d",
      borderVisible: false,
      wickUpColor: "rgba(46,230,168,0.6)",
      wickDownColor: "rgba(255,77,109,0.6)",
      priceFormat: { type: "price", precision: 8, minMove: 1e-8 },
    });
    const vol = chart.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      color: "rgba(86,110,160,0.35)",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart;
    seriesRef.current = series;
    volRef.current = vol;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    if (!seriesRef.current || !volRef.current || candles.length === 0) return;
    seriesRef.current.setData(
      candles.map((c) => ({ time: (c.t / 1000) as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c })),
    );
    volRef.current.setData(
      candles.map((c) => ({
        time: (c.t / 1000) as UTCTimestamp,
        value: c.v,
        color: c.c >= c.o ? "rgba(46,230,168,0.22)" : "rgba(255,77,109,0.22)",
      })),
    );
    if (markers.length) {
      const sorted = [...markers].sort((a, b) => a.ts - b.ts);
      createSeriesMarkers(
        seriesRef.current,
        sorted.map((m) => ({
          time: (Math.floor(m.ts / 3600_000) * 3600) as UTCTimestamp,
          position: m.kind.includes("sell") ? ("aboveBar" as const) : ("belowBar" as const),
          color: m.kind === "signal" ? "#38e1ff" : m.kind.includes("sell") ? "#ff4d6d" : "#2ee6a8",
          shape: m.kind === "signal" ? ("circle" as const) : m.kind.includes("sell") ? ("arrowDown" as const) : ("arrowUp" as const),
          text: m.text,
        })),
      );
    }
    chartRef.current?.timeScale().fitContent();
  }, [candles, markers]);

  // live tick: update the in-progress bar
  useEffect(() => {
    if (!seriesRef.current || !livePrice || candles.length === 0) return;
    const last = candles[candles.length - 1];
    const barStart = Math.floor(livePrice.ts / 3600_000) * 3600_000;
    const base = barStart === last.t ? last : { t: barStart, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 };
    seriesRef.current.update({
      time: (base.t / 1000) as UTCTimestamp,
      open: base.o,
      high: Math.max(base.h, livePrice.price),
      low: Math.min(base.l, livePrice.price),
      close: livePrice.price,
    });
  }, [livePrice, candles]);

  return <div ref={ref} style={{ height }} className="w-full" />;
}
