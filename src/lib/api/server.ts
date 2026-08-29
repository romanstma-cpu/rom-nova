import { NextResponse } from "next/server";
import { ApiError } from "./handlers";

/** Wrap a handler call into a JSON response, mapping ApiError to its status. */
export function respond(fn: () => unknown): NextResponse {
  try {
    return NextResponse.json(fn());
  } catch (err) {
    return failure(err);
  }
}

/**
 * The same contract for handlers that reach a provider.
 *
 * Needed because a handler that can consult a live adapter is a network call,
 * and the synchronous wrapper would resolve its promise into the body — an
 * endpoint returning `{}` with status 200 instead of data, which is the kind of
 * failure that looks like an empty market rather than a bug.
 */
export async function respondAsync(fn: () => Promise<unknown>): Promise<NextResponse> {
  try {
    return NextResponse.json(await fn());
  } catch (err) {
    return failure(err);
  }
}

function failure(err: unknown): NextResponse {
  if (err instanceof ApiError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error("[rom-nova] handler failure", err);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
