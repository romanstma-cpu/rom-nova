// The interval switcher's honesty machinery.
//
// Two traps guard this feature. The endpoint's from/to are milliseconds and
// seconds return an EMPTY 200, so a wrong unit reads as "no history" rather
// than as an error — which is why the request builder is tested down to the
// query string. And the caption on the chart prints what the bars ARE, not
// what was asked for, because at least one path (the 45-day hourly ask through
// the Jupiter fallback) already serves coarser than its ask.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MarketDataProvider } from "@/lib/providers/types";
import type { Candle } from "@/lib/types";

const market: { current: MarketDataProvider } = {
  current: { name: "demo", getCandles: async () => [], getPrice: async () => null },
};

vi.mock("@/lib/providers/registry", () => ({
  getProviders: () => ({ mode: "demo", market: market.current }),
}));

// The fake wire. jupiter-chart's real code runs against this, so the URL it
// builds — interval name, ms bounds, candle count — is what gets asserted.
const wire = {
  urls: [] as string[],
  reply: null as unknown,
  fail: null as Error | null,
};

vi.mock("@/lib/providers/http", () => ({
  providerFetch: async (_provider: string, url: string) => {
    wire.urls.push(url);
    if (wire.fail) throw wire.fail;
    return wire.reply;
  },
}));

import {
  JupiterChartProvider,
  asChartInterval,
  NAMED_INTERVALS,
  bucketFor,
} from "@/lib/providers/jupiter-chart";
import { candlesFor, measuredInterval } from "@/lib/api/source";
import { DemoStore } from "@/lib/demo/store";

const store = new DemoStore(77);
const mint = store.tokenList()[0].info.mint;

/** n bars spaced stepMs apart, ending near now. Times in ms like every Candle. */
function bars(n: number, stepMs: number, endMs = 1_756_600_000_000): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const t = endMs - (n - 1 - i) * stepMs;
    return { t, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 };
  });
}

/** The same bars as the endpoint would ship them: seconds, not milliseconds. */
function wireBars(n: number, stepMs: number) {
  return {
    candles: bars(n, stepMs).map((c) => ({
      time: c.t / 1000,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
      volume: c.v,
    })),
  };
}

beforeEach(() => {
  wire.urls = [];
  wire.reply = { candles: [] };
  wire.fail = null;
  market.current = { name: "demo", getCandles: async () => [], getPrice: async () => null };
});

describe("asChartInterval — a whitelist, not a parser", () => {
  it("passes every named interval through", () => {
    for (const name of Object.keys(NAMED_INTERVALS)) {
      expect(asChartInterval(name)).toBe(name);
    }
  });

  it("answers hourly for anything else, including injection-shaped input", () => {
    expect(asChartInterval(null)).toBe("1h");
    expect(asChartInterval(undefined)).toBe("1h");
    expect(asChartInterval("1_SECOND")).toBe("1h");
    expect(asChartInterval("<script>")).toBe("1h");
    expect(asChartInterval("2h")).toBe("1h");
  });
});

describe("getCandlesAt — the request the probe verified, byte for byte", () => {
  it("asks for the named bucket with millisecond bounds", async () => {
    wire.reply = wireBars(12, 60_000);
    const jup = new JupiterChartProvider();
    const to = 1_756_600_000_000;
    const from = to - 3_600_000;
    await jup.getCandlesAt("So11111111111111111111111111111111111111112", "1m", from, to);
    expect(wire.urls).toHaveLength(1);
    const u = new URL(wire.urls[0]);
    expect(u.searchParams.get("interval")).toBe("1_MINUTE");
    // MILLISECONDS. Seconds here return 200 with zero candles — the silent
    // empty this adapter was written against.
    expect(u.searchParams.get("from")).toBe(String(from));
    expect(u.searchParams.get("to")).toBe(String(to));
    expect(u.searchParams.get("candles")).toBe("60");
  });

  it("clamps the bar count to the request cap", async () => {
    wire.reply = wireBars(3, 60_000);
    const jup = new JupiterChartProvider();
    const to = 1_756_600_000_000;
    await jup.getCandlesAt("m", "1m", to - 7 * 86_400_000, to); // 10,080 minutes
    const u = new URL(wire.urls[0]);
    expect(u.searchParams.get("candles")).toBe("1000");
  });

  it("converts the response's seconds back to milliseconds", async () => {
    wire.reply = wireBars(4, 300_000);
    const jup = new JupiterChartProvider();
    const out = await jup.getCandlesAt("m", "5m", 1, 2);
    expect(out).toHaveLength(4);
    // Wire times were seconds; every Candle in this app carries ms.
    expect(out[1].t - out[0].t).toBe(300_000);
    expect(out[0].t).toBeGreaterThan(1e12);
  });

  it("fills each interval's default window when from is open-ended", async () => {
    wire.reply = wireBars(3, 60_000);
    const jup = new JupiterChartProvider();
    await jup.getCandlesAt("m", "5m", 0, 0);
    const u = new URL(wire.urls[0]);
    const from = Number(u.searchParams.get("from"));
    const to = Number(u.searchParams.get("to"));
    expect(to - from).toBe(NAMED_INTERVALS["5m"].defaultSpanMs);
  });
});

describe("bucketFor — the hourly path still never goes sub-hour on its own", () => {
  it("serves 4-hour buckets for a 45-day window rather than blowing the cap", () => {
    const to = 1_756_600_000_000;
    const b = bucketFor(to - 45 * 86_400_000, to);
    expect(b.interval).toBe("4_HOUR");
  });

  it("stays hourly when the window fits", () => {
    const to = 1_756_600_000_000;
    const b = bucketFor(to - 10 * 86_400_000, to);
    expect(b.interval).toBe("1_HOUR");
  });
});

describe("measuredInterval — the caption prints what the bars are", () => {
  it("names each bucket from its spacing", () => {
    expect(measuredInterval(bars(10, 60_000))).toBe("1m");
    expect(measuredInterval(bars(10, 300_000))).toBe("5m");
    expect(measuredInterval(bars(10, 900_000))).toBe("15m");
    expect(measuredInterval(bars(10, 3_600_000))).toBe("1h");
    expect(measuredInterval(bars(10, 14_400_000))).toBe("4h");
    expect(measuredInterval(bars(10, 86_400_000))).toBe("1d");
  });

  it("survives a quiet gap — one missing bar must not relabel the tape", () => {
    const b = bars(20, 300_000);
    b.splice(7, 1); // a 10-minute hole in a 5-minute tape
    expect(measuredInterval(b)).toBe("5m");
  });

  it("refuses to name what it cannot measure", () => {
    expect(measuredInterval(bars(2, 300_000))).toBeNull(); // too few deltas
    expect(measuredInterval(bars(10, 123_456))).toBeNull(); // no such bucket
    expect(measuredInterval([])).toBeNull();
  });
});

describe("candlesFor with an interval — Jupiter direct, degradation labelled", () => {
  const gecko: MarketDataProvider = {
    name: "geckoterminal",
    getCandles: async () => bars(48, 3_600_000),
    getPrice: async () => null,
  };

  it("serves the finer bars from jupiter-charts, named as such", async () => {
    market.current = gecko;
    wire.reply = wireBars(30, 300_000);
    const r = await candlesFor(store, mint, undefined, undefined, "5m");
    expect(r.provenance).toEqual({ source: "jupiter-charts", real: true });
    expect(measuredInterval(r.data)).toBe("5m");
  });

  it("never lets a finer ask touch the serialised primary", async () => {
    const spy = vi.fn(gecko.getCandles);
    market.current = { ...gecko, getCandles: spy };
    wire.reply = wireBars(30, 60_000);
    await candlesFor(store, mint, undefined, undefined, "1m");
    expect(spy).not.toHaveBeenCalled();
  });

  it("degrades an empty finer answer to hourly AND says so", async () => {
    market.current = gecko;
    wire.reply = { candles: [] };
    const r = await candlesFor(store, mint, undefined, undefined, "5m");
    expect(r.provenance.real).toBe(true);
    expect(r.provenance.source).toBe("geckoterminal");
    expect(r.provenance.note).toContain("no 5m bars");
    expect(measuredInterval(r.data)).toBe("1h");
  });

  it("degrades a thrown finer ask the same way", async () => {
    market.current = gecko;
    wire.fail = new Error("HTTP 500");
    const r = await candlesFor(store, mint, undefined, undefined, "5m");
    expect(r.provenance.note).toContain("no 5m bars");
    expect(measuredInterval(r.data)).toBe("1h");
  });

  it("keeps the hourly ask on the existing primary path untouched", async () => {
    market.current = gecko;
    const r = await candlesFor(store, mint, undefined, undefined, "1h");
    expect(r.provenance).toEqual({ source: "geckoterminal", real: true });
    expect(wire.urls).toHaveLength(0); // jupiter never consulted
  });

  it("stays on the simulator for demo mode regardless of the ask", async () => {
    const r = await candlesFor(store, mint, undefined, undefined, "5m");
    expect(r.provenance.source).toBe("demo");
    expect(wire.urls).toHaveLength(0);
  });
});
