import { NextResponse } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleWallets } from "@/lib/api/handlers";

export async function GET() {
  return NextResponse.json(handleWallets(ensureSimulator()));
}
