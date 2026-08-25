import { NextRequest, NextResponse } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleSearch } from "@/lib/api/handlers";

export async function GET(req: NextRequest) {
  return NextResponse.json(handleSearch(ensureSimulator(), req.nextUrl.searchParams.get("q") ?? ""));
}
