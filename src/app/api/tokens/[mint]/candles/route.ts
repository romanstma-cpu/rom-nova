import { NextRequest } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleCandles } from "@/lib/api/handlers";
import { respond } from "@/lib/api/server";

export async function GET(req: NextRequest, ctx: { params: Promise<{ mint: string }> }) {
  const store = ensureSimulator();
  const { mint } = await ctx.params;
  const from = Number(req.nextUrl.searchParams.get("from")) || undefined;
  const to = Number(req.nextUrl.searchParams.get("to")) || undefined;
  return respond(() => handleCandles(store, mint, from, to));
}
