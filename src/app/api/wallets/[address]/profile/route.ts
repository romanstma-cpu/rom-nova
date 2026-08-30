import { NextRequest } from "next/server";
import { handleWalletProfile } from "@/lib/api/handlers";
import { respondAsync } from "@/lib/api/server";

// No DemoStore. This route reads Solana, and taking the simulator as an
// argument is exactly how the previous wallet endpoints ended up unable to
// answer for an address that was not in the synthetic universe.
//
// `?stage=balances` serves the fast first paint — identity, holdings and
// prices, no signature or transaction reads at all.
export async function GET(req: NextRequest, ctx: { params: Promise<{ address: string }> }) {
  const { address } = await ctx.params;
  const stage = req.nextUrl.searchParams.get("stage") === "balances" ? "balances" : "full";
  return respondAsync(() => handleWalletProfile(address, stage));
}
