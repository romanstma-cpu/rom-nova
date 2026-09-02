// "Smart money" and "whale" each meant two different things on two different
// pages. The whole-build review measured it: the dashboard's "Smart $ Flow
// 24h" at -$2.34M (a smart wallet was `>= 70` in marketState) against /flow's
// "Smart money net" at -$2.85M (`>= 65` in buildFlowSeries) — same universe,
// same window, same words, 22% apart. "Active Whales 24h" counted a trade at
// $25,000 while every other whale column counted at $20,000.
//
// One constant each, imported everywhere. This file pins that it stays that
// way: the constants exist, the live path reads the same whale figure, and no
// source file restates either number as a literal beside the words.

import { describe, it, expect } from "vitest";
import { SMART_MONEY_THRESHOLD, WHALE_TRADE_USD } from "@/lib/engine/thresholds";
import { WHALE_USD } from "@/lib/engine/live-features";
import { DemoStore } from "@/lib/demo/store";
import { buildFlowSeries } from "@/lib/api/rows";
import { HOUR } from "@/lib/demo/universe";

describe("one definition of smart money and of a whale", () => {
  it("is the live path's whale figure too, by import rather than by agreement", () => {
    expect(WHALE_USD).toBe(WHALE_TRADE_USD);
  });

  // The dashboard and the flow page must count the SAME wallets as smart. Both
  // read the store, so the check is on the definition they share: a trade by a
  // wallet exactly at the threshold counts on the flow chart, and one just
  // under it does not. Before the constant, the chart counted at 65 and the
  // dashboard at 70, so a 67-point wallet was smart on one page and not the
  // other.
  it("counts a wallet at the threshold as smart on the flow chart", () => {
    const store = new DemoStore(77);
    const now = store.simulatedUntil;
    const at = store.walletList().find((w) => w.smartMoney.total >= SMART_MONEY_THRESHOLD);
    const under = store.walletList().find((w) => w.smartMoney.total < SMART_MONEY_THRESHOLD);
    expect(at).toBeTruthy();
    expect(under).toBeTruthy();
    const mint = store.tokenList()[0].info.mint;
    const before = buildFlowSeries(store, mint, 2, now).reduce((s, p) => s + p.smNetUsd, 0);
    // One synthetic buy each, inside the window the series covers.
    const trade = (wallet: string, id: string) => ({
      id,
      signature: id,
      wallet,
      mint,
      ts: now - HOUR / 2,
      side: "buy" as const,
      amountUsd: 1_000,
      amountTokens: 1_000,
      priceUsd: 1,
      dex: "Raydium" as const,
      classification: "open" as const,
      confidence: 0.9,
    });
    store.liveTrades.push(trade(at!.address, "t-at"), trade(under!.address, "t-under"));
    const after = buildFlowSeries(store, mint, 2, now).reduce((s, p) => s + p.smNetUsd, 0);
    // Exactly one of the two buys counted: the wallet at the threshold.
    expect(after - before).toBeCloseTo(1_000, 6);
  });

  // The guard that keeps the fix from being undone one file at a time. A
  // literal beside the words is the bug, whatever value it holds today.
  it("restates neither number as a literal anywhere under src", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const here = new URL("./", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const src = path.join(here, "..", "src");
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (/\.tsx?$/.test(e.name)) out.push(full);
      }
      return out;
    };
    const offenders: string[] = [];
    for (const file of await walk(src)) {
      if (file.endsWith(path.join("engine", "thresholds.ts"))) continue;
      const text = await fs.readFile(file, "utf8");
      // `smartMoney.total >= 65`, `smartMoneyScore >= 65`, `sm.total >= 65`:
      // the smart-money test as a number, in every spelling the pages used.
      // The first draft of this guard knew only the first spelling and found
      // two; widening it found three more.
      if (/\b(smartMoney\.total|smartMoneyScore|sm\.total)\s*>=\s*\d/.test(text)) {
        offenders.push(`${path.basename(file)} :: smart-money literal`);
      }
      // `amountUsd >= 20_000` / `>= 25_000` / `>= 8000`: the whale test as a
      // number. The last one painted an $8,000 trade as a whale marker.
      if (/amountUsd\s*>=\s*\d/.test(text)) offenders.push(`${path.basename(file)} :: whale literal`);
    }
    expect(offenders).toEqual([]);
  });
});
