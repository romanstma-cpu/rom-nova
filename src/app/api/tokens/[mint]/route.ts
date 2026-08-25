import { NextRequest } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleTokenDetail } from "@/lib/api/handlers";
import { respond } from "@/lib/api/server";
import type { StrategyProfileId } from "@/lib/types";

export async function GET(req: NextRequest, ctx: { params: Promise<{ mint: string }> }) {
  const store = ensureSimulator();
  const { mint } = await ctx.params;
  const asOfRaw = req.nextUrl.searchParams.get("asOf");
  const asOf = asOfRaw ? Number(asOfRaw) : undefined;
  const profile = (req.nextUrl.searchParams.get("profile") ?? "balanced") as StrategyProfileId;
  return respond(() => handleTokenDetail(store, mint, asOf, profile));
}
