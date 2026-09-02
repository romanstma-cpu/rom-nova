import { NextRequest } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleSignals } from "@/lib/api/handlers";
import { respondAsync } from "@/lib/api/server";
import type { StrategyProfileId } from "@/lib/types";

export async function GET(req: NextRequest) {
  const store = ensureSimulator();
  const profile = (req.nextUrl.searchParams.get("profile") ?? "balanced") as StrategyProfileId;
  const asOfRaw = req.nextUrl.searchParams.get("asOf");
  // Async now: the feed consults the live token list before it answers.
  return respondAsync(() => handleSignals(store, profile, asOfRaw ? Number(asOfRaw) : undefined));
}
