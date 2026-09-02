import { NextRequest } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleSignalById } from "@/lib/api/handlers";
import { respondAsync } from "@/lib/api/server";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const store = ensureSimulator();
  const { id } = await ctx.params;
  // Async now: a live id recomputes on the detail path, which is a network call.
  return respondAsync(() => handleSignalById(store, id));
}
