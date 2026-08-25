import { NextRequest, NextResponse } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleEvents } from "@/lib/api/handlers";

export async function GET(req: NextRequest) {
  const store = ensureSimulator();
  return NextResponse.json(handleEvents(store, Number(req.nextUrl.searchParams.get("limit")) || 60));
}
