import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleBacktest } from "@/lib/api/handlers";

const Body = z.object({
  profile: z
    .enum(["conservative", "balanced", "aggressive", "early_gem", "smart_money", "momentum", "mean_reversion", "whale_shadow", "high_risk"])
    .default("balanced"),
  days: z.number().int().min(3).max(25).default(10),
  minLiquidityUsd: z.number().min(0).default(50_000),
  maxMarketCapUsd: z.number().min(10_000).default(50_000_000),
  minScore: z.number().min(0).max(100).default(70),
  minConfidence: z.number().min(0).max(1).default(0.45),
  holdHours: z.number().min(1).max(168).default(24),
  stopLossPct: z.number().min(1).max(90).default(20),
  takeProfitPct: z.number().min(1).max(500).default(40),
  positionUsd: z.number().min(10).max(5000).default(500),
  maxConcurrent: z.number().int().min(1).max(20).default(5),
  slippagePct: z.number().min(0).max(10).default(1.5),
  feePct: z.number().min(0).max(5).default(0.6),
  entryDelayMin: z.number().min(0).max(120).default(10),
});

export async function POST(req: NextRequest) {
  const store = ensureSimulator();
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    /* empty body = defaults */
  }
  const parsed = Body.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
      { status: 400 },
    );
  }
  return NextResponse.json(handleBacktest(store, parsed.data));
}
