import { NextRequest, NextResponse } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleAccuracy } from "@/lib/api/handlers";
import type { StrategyProfileId } from "@/lib/types";

export async function GET(req: NextRequest) {
  const store = ensureSimulator();
  const profile = (req.nextUrl.searchParams.get("profile") ?? "balanced") as StrategyProfileId;
  const scope = req.nextUrl.searchParams.get("scope") === "simulated" ? "simulated" : "auto";
  return NextResponse.json(handleAccuracy(store, profile, scope));
}
