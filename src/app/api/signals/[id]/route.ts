import { NextRequest } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleSignalById } from "@/lib/api/handlers";
import { respond } from "@/lib/api/server";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const store = ensureSimulator();
  const { id } = await ctx.params;
  return respond(() => handleSignalById(store, id));
}
