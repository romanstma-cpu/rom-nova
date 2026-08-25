import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleTokens } from "@/lib/api/handlers";

const Query = z.object({
  profile: z
    .enum(["conservative", "balanced", "aggressive", "early_gem", "smart_money", "momentum", "mean_reversion", "whale_shadow", "high_risk"])
    .default("balanced"),
  asOf: z.coerce.number().int().positive().optional(),
  sort: z.string().default("signalScore"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function GET(req: NextRequest) {
  const store = ensureSimulator();
  const parsed = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  return NextResponse.json(handleTokens(store, parsed.data));
}
