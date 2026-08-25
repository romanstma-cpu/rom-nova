import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleResearchAsk } from "@/lib/api/handlers";

const Body = z.object({ question: z.string().min(2).max(500) });

export async function POST(req: NextRequest) {
  const store = ensureSimulator();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid question" }, { status: 400 });
  return NextResponse.json(handleResearchAsk(store, parsed.data.question));
}
