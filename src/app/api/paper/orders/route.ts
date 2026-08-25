import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handlePaperOrder } from "@/lib/api/handlers";

const Body = z.object({
  portfolioId: z.string(),
  mint: z.string().min(30),
  side: z.enum(["buy", "sell"]),
  usd: z.number().positive().max(1_000_000),
  stopLossPct: z.number().min(1).max(95).optional(),
  takeProfitPct: z.number().min(1).max(1000).optional(),
});

export async function POST(req: NextRequest) {
  const store = ensureSimulator();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
      { status: 400 },
    );
  }
  const res = handlePaperOrder(store, parsed.data);
  return NextResponse.json(res.body, { status: res.status });
}
