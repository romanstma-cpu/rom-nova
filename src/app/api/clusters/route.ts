import { NextResponse } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleClusters } from "@/lib/api/handlers";

export async function GET() {
  return NextResponse.json(handleClusters(ensureSimulator()));
}
