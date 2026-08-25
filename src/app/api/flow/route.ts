import { NextRequest } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";
import { handleFlow } from "@/lib/api/handlers";
import { respond } from "@/lib/api/server";

export async function GET(req: NextRequest) {
  const store = ensureSimulator();
  const mint = req.nextUrl.searchParams.get("mint");
  const hours = Number(req.nextUrl.searchParams.get("hours")) || 72;
  return respond(() => handleFlow(store, mint, hours));
}
