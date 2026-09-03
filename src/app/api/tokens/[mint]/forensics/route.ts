import { NextRequest } from "next/server";
import { handleLaunchForensics } from "@/lib/api/handlers";
import { respondAsync } from "@/lib/api/server";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ mint: string }> }) {
  const { mint } = await ctx.params;
  // respondAsync: this walks the chain and must not serialise a pending promise.
  return respondAsync(() => handleLaunchForensics(mint));
}
