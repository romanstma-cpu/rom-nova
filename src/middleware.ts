import { NextRequest, NextResponse } from "next/server";

// Server-mode API rate limiting: a per-IP sliding window. The public
// deployment is the static export (no server, nothing to limit); this
// protects anyone who chooses to expose server mode.
// The static build script sets this file aside — middleware is not
// supported with `output: "export"`.

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 240; // generous: the dashboard polls several endpoints

const hits = new Map<string, number[]>();
let lastSweep = 0;

export function middleware(req: NextRequest) {
  if (!req.nextUrl.pathname.startsWith("/api/")) return NextResponse.next();
  // SSE holds one long request; don't count it against the window
  if (req.nextUrl.pathname === "/api/stream") return NextResponse.next();

  const now = Date.now();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

  if (now - lastSweep > WINDOW_MS) {
    lastSweep = now;
    for (const [key, arr] of hits) {
      const alive = arr.filter((t) => t > now - WINDOW_MS);
      if (alive.length === 0) hits.delete(key);
      else hits.set(key, alive);
    }
  }

  const arr = (hits.get(ip) ?? []).filter((t) => t > now - WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);

  if (arr.length > MAX_REQUESTS) {
    return NextResponse.json(
      { error: "rate limit exceeded — try again shortly" },
      { status: 429, headers: { "Retry-After": "30" } },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
