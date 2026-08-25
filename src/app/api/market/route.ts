import { NextResponse } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleMarket } from "@/lib/api/handlers";
import { getSolReference } from "@/lib/providers/reference";

export async function GET() {
  const store = ensureSimulator();
  // The token universe is synthetic; the SOL reference price is real, pulled
  // from keyless public APIs and cross-checked. The two are never mixed
  // silently — the reference is returned as its own labeled object.
  const reference = await getSolReference().catch(() => null);
  return NextResponse.json({ ...handleMarket(store), reference });
}
