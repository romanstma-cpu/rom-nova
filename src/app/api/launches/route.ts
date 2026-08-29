import { handleLaunches } from "@/lib/api/handlers";
import { respondAsync } from "@/lib/api/server";

// No query parameters on purpose. Filtering happens in the browser against the
// feed it already holds: the whole list is a few hundred rows, and a filter
// that costs a round trip would make "min liquidity" feel like a page load on
// the one screen where a second matters.
export async function GET() {
  return respondAsync(() => handleLaunches());
}
