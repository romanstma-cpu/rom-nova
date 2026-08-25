import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleResearchGet, handleResearchNote } from "@/lib/api/handlers";
import { respond } from "@/lib/api/server";

export async function GET() {
  return NextResponse.json(handleResearchGet(ensureSimulator()));
}

const Body = z.object({ mint: z.string().min(30), note: z.string().min(1).max(2000) });

export async function POST(req: NextRequest) {
  const store = ensureSimulator();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  return respond(() => handleResearchNote(store, parsed.data.mint, parsed.data.note));
}
