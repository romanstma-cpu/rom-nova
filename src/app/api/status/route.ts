import { NextResponse } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleStatus } from "@/lib/api/handlers";

export async function GET() {
  return NextResponse.json(handleStatus(ensureSimulator()));
}
