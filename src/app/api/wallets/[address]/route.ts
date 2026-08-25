import { NextRequest } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleWalletDetail } from "@/lib/api/handlers";
import { respond } from "@/lib/api/server";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ address: string }> }) {
  const store = ensureSimulator();
  const { address } = await ctx.params;
  return respond(() => handleWalletDetail(store, address));
}
