import { NextRequest, NextResponse } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleNetwork } from "@/lib/api/handlers";

export async function GET(req: NextRequest) {
  const store = ensureSimulator();
  const asOfRaw = req.nextUrl.searchParams.get("asOf");
  return NextResponse.json(handleNetwork(store, asOfRaw ? Number(asOfRaw) : undefined));
}
