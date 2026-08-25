import { NextResponse } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handlePaperGet } from "@/lib/api/handlers";

export async function GET() {
  return NextResponse.json(handlePaperGet(ensureSimulator()));
}
