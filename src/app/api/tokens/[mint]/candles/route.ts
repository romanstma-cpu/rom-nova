import { NextRequest } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleCandles } from "@/lib/api/handlers";
import { respondAsync } from "@/lib/api/server";
import { asChartInterval } from "@/lib/providers/jupiter-chart";

export async function GET(req: NextRequest, ctx: { params: Promise<{ mint: string }> }) {
  const store = ensureSimulator();
  const { mint } = await ctx.params;
  const from = Number(req.nextUrl.searchParams.get("from")) || undefined;
  const to = Number(req.nextUrl.searchParams.get("to")) || undefined;
  const interval = asChartInterval(req.nextUrl.searchParams.get("interval"));
  return respondAsync(() => handleCandles(store, mint, from, to, interval));
}
