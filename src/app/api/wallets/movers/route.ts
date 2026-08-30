import { NextResponse } from "next/server";
import { handleLiveMovers } from "@/lib/api/handlers";
import { respondAsync } from "@/lib/api/server";

// Real wallets moving real size right now, aggregated from the flow the
// scanner already streams. No simulator involved, so no DemoStore argument.
export async function GET(): Promise<NextResponse> {
  return respondAsync(() => handleLiveMovers());
}
