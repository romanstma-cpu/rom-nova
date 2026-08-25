import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleWatchlists, handleWatchlistOp } from "@/lib/api/handlers";
import { respond } from "@/lib/api/server";

export async function GET() {
  return NextResponse.json(handleWatchlists(ensureSimulator()));
}

const PostBody = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), name: z.string().min(1).max(60) }),
  z.object({ op: z.literal("add"), id: z.string(), kind: z.enum(["token", "wallet"]), ref: z.string().min(3) }),
  z.object({ op: z.literal("remove"), id: z.string(), ref: z.string() }),
  z.object({ op: z.literal("delete"), id: z.string() }),
]);

export async function POST(req: NextRequest) {
  const store = ensureSimulator();
  const parsed = PostBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  return respond(() => handleWatchlistOp(store, parsed.data));
}
