import { NextResponse } from "next/server";
import { ApiError } from "./handlers";

/** Wrap a handler call into a JSON response, mapping ApiError to its status. */
export function respond(fn: () => unknown): NextResponse {
  try {
    return NextResponse.json(fn());
  } catch (err) {
    if (err instanceof ApiError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[rom-nova] handler failure", err);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
