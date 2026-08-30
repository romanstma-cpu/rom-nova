"use client";

// Candlestick + volume chart on lightweight-charts v5, with optional
// trade/signal markers. Updates in place on live ticks.
//
// The crosshair readout below the header is the difference between a picture of
// a price and a chart somebody can work from. A memecoin's bars are four
// significant digits below a cent and the price axis can only label a handful of
// them, so without an OHLC readout under the cursor the reader cannot answer
// "what did it actually do in that hour" — which is the question a candle exists
// to answer.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@/lib/types";

export interface ChartMarker {
  ts: number;
  kind: "whale_buy" | "whale_sell" | "smart_buy" | "smart_sell" | "signal";
  text: string;
}

/** What the cursor is over. Null when it has left the plot. */
interface Readout {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function PriceChart({
  candles,
  markers = [],
  height = 340,
  livePrice,
  logScale = false,
}: {
  candles: Candle[];
  markers?: ChartMarker[];
  height?: number;
  livePrice?: { ts: number; price: number } | null;
  /** Log price axis. A token that ran 50x is unreadable on a linear scale. */
  logScale?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markerRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [hover, setHover] = useState<Readout | null>(null);

  // The bars, kept where the crosshair handler can reach them without being
  // re-subscribed on every data arrival. Written in an effect, never in render.
  const barsRef = useRef<Candle[]>(candles);

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

    // The bar under the cursor, looked up by time rather than read out of the
    // event: the crosshair payload carries the series value but not the volume,
    // and a readout missing volume is missing the half that says whether the
    // move had anyone behind it.
    chart.subscribeCrosshairMove((param) => {
      const time = param.time as UTCTimestamp | undefined;
      if (time === undefined || !param.point) {
        setHover(null);
        return;
      }
      const ms = Number(time) * 1000;
      const bar = barsRef.current.find((c) => c.t === ms);
      setHover(bar ? { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v } : null);
    });

    chartRef.current = chart;
    seriesRef.current = series;
    volRef.current = vol;
    markerRef.current = createSeriesMarkers(series, []);
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volRef.current = null;
      markerRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    chartRef.current
      ?.priceScale("right")
      .applyOptions({ mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
  }, [logScale]);

  useEffect(() => {
    barsRef.current = candles;
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
    // setMarkers rather than a fresh primitive per update: the old call left
    // every previous batch attached, so a re-poll stacked duplicate arrows on
    // the same bars and an empty batch never cleared the last one.
    markerRef.current?.setMarkers(
      [...markers]
        .sort((a, b) => a.ts - b.ts)
        .map((m) => ({
          time: (Math.floor(m.ts / 3600_000) * 3600) as UTCTimestamp,
          position: m.kind.includes("sell") ? ("aboveBar" as const) : ("belowBar" as const),
          color: m.kind === "signal" ? "#38e1ff" : m.kind.includes("sell") ? "#ff4d6d" : "#2ee6a8",
          shape: m.kind === "signal" ? ("circle" as const) : m.kind.includes("sell") ? ("arrowDown" as const) : ("arrowUp" as const),
          text: m.text,
        })),
    );
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

  const fit = useCallback(() => chartRef.current?.timeScale().fitContent(), []);

  return (
    <div className="relative">
      <div ref={ref} style={{ height }} className="w-full" onDoubleClick={fit} />
      <ChartReadout bar={hover} last={candles[candles.length - 1]} />
    </div>
  );
}

/**
 * The OHLC strip. Falls back to the newest bar when the cursor is off the plot,
 * so the strip always describes a real bar rather than blinking empty.
 */
function ChartReadout({ bar, last }: { bar: Readout | null; last: Candle | undefined }) {
  const b = bar ?? last;
  if (!b) return null;
  const up = b.c >= b.o;
  return (
    <div className="absolute top-1 left-2 flex gap-3 num text-[10px] pointer-events-none">
      <span className="faint">{new Date(b.t).toISOString().slice(0, 16).replace("T", " ")}</span>
      <span className="faint">
        O <span className={up ? "pos" : "neg"}>{price(b.o)}</span>
      </span>
      <span className="faint">
        H <span className={up ? "pos" : "neg"}>{price(b.h)}</span>
      </span>
      <span className="faint">
        L <span className={up ? "pos" : "neg"}>{price(b.l)}</span>
      </span>
      <span className="faint">
        C <span className={up ? "pos" : "neg"}>{price(b.c)}</span>
      </span>
      <span className="faint">
        V ${b.v >= 1e6 ? `${(b.v / 1e6).toFixed(2)}M` : b.v >= 1e3 ? `${(b.v / 1e3).toFixed(1)}K` : b.v.toFixed(0)}
      </span>
    </div>
  );
}

/** Four significant digits, whatever the exponent — meme prices live at 1e-9. */
function price(x: number): string {
  if (!Number.isFinite(x)) return "—";
  if (x >= 1) return x.toFixed(4);
  const exp = Math.floor(Math.log10(Math.abs(x) || 1));
  return x.toFixed(Math.min(12, 3 - exp));
}
