// The model is allowed to reword facts and nothing else. These tests cover the
// mechanism that enforces it, because "the prompt says not to" is not a
// guarantee — it is a hope with good manners.

import { describe, it, expect } from "vitest";
import { unsupportedNumbers, type NarrationInput } from "@/lib/ai/narrate";
import { looksLikeKey, maskKey, FREE_MODELS, DEFAULT_MODEL } from "@/lib/ai/config";

const input: NarrationInput = {
  question: "why is BONK moving",
  answer: "BONK scores 36/100 (NO TRADE, confidence 65%). Liquidity is $742,833 pooled.",
  evidence: [
    { label: "Liquidity Quality", value: "$742,833 pooled, +0.0% vs 24h ago" },
    { label: "Momentum", value: "1h +0.3%, 24h +4.6%" },
    { label: "Volume Acceleration", value: "6h volume running at 83% of its trailing baseline" },
  ],
};

describe("numbers must come from the evidence", () => {
  it("accepts a faithful rewording", () => {
    const text =
      "BONK scores 36 out of 100 and the engine is abstaining at 65% confidence. " +
      "There is $742,833 pooled, momentum is +4.6% over 24h, and 6h volume is running at 83% of baseline.";
    expect(unsupportedNumbers(text, input)).toEqual([]);
  });

  it("catches an invented market figure", () => {
    // The failure this whole mechanism exists for: a plausible, confident,
    // completely fabricated liquidity number in the app's own house voice.
    const text = "BONK looks steady with $1,240,000 pooled and momentum of +4.6% over 24h.";
    expect(unsupportedNumbers(text, input)).toContain("1240000");
  });

  it("catches a fabricated percentage", () => {
    const text = "Momentum is running at +19.4% over 24h.";
    expect(unsupportedNumbers(text, input)).toContain("19.4");
  });

  it("allows small integers used for counting", () => {
    // "three of the four factors" is counting visible things, not inventing a
    // market number, and rejecting it would fail almost every good sentence.
    const text = "Two of the three evidence lines point the same way across 4 measures.";
    expect(unsupportedNumbers(text, input)).toEqual([]);
  });

  it("allows rounding to the precision the model actually wrote", () => {
    const rounded: NarrationInput = {
      ...input,
      evidence: [{ label: "top10", value: "38.63%" }],
      answer: "top 10 hold 38.63%",
    };
    expect(unsupportedNumbers("The top ten hold about 38.6% of supply.", rounded)).toEqual([]);
  });

  it("treats a rewritten magnitude as unsupported", () => {
    // $742.8K is a different digit string from 742,833. A reader cannot tell a
    // considerate rounding from a fabrication, so neither does the check —
    // and the deterministic answer already states it exactly.
    expect(unsupportedNumbers("There is $742.8K pooled.", input)).toContain("742.8");
  });

  it("reads numbers out of commas and currency symbols alike", () => {
    expect(unsupportedNumbers("Pooled liquidity is $742833.", input)).toEqual([]);
  });

  it("does not object to prose with no numbers at all", () => {
    expect(unsupportedNumbers("Liquidity is healthy and momentum is mildly positive.", input)).toEqual([]);
  });
});

describe("key handling", () => {
  it("recognises an OpenRouter key", () => {
    expect(looksLikeKey("sk-or-v1-0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it("rejects a placeholder, a truncated paste, and a quoted paste", () => {
    expect(looksLikeKey("your_key_here")).toBe(false);
    expect(looksLikeKey("sk-or-v1-short")).toBe(false);
    expect(looksLikeKey('"sk-or-v1-0123456789abcdef0123456789abcdef"')).toBe(false);
  });

  it("never renders a key in full", () => {
    const key = "sk-or-v1-0123456789abcdef0123456789abcdef";
    const masked = maskKey(key);
    expect(masked).not.toContain("0123456789abcdef0123456789abcdef");
    expect(masked.length).toBeLessThan(key.length);
    expect(masked).toContain("…");
  });

  it("offers only models that cost nothing", () => {
    expect(FREE_MODELS.length).toBeGreaterThan(0);
    for (const m of FREE_MODELS) expect(m.id).toMatch(/:free$/);
    expect(FREE_MODELS.some((m) => m.id === DEFAULT_MODEL)).toBe(true);
  });
});
