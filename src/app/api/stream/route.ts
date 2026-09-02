import { NextRequest } from "next/server";
import { ensureSimulator } from "@/lib/demo/simulator";

export const dynamic = "force-dynamic";

// Server-sent events: live feed for the dashboard and 3D scene.
export async function GET(req: NextRequest) {
  const store = ensureSimulator();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // stream already closed
        }
      };
      send({ hello: true, ts: Date.now() });
      // Server mode has no sockets, so every event down this stream is the
      // simulator's — stamped as such, the way the static build's bus stamps
      // its demo half, so the renderers read one field on both paths.
      const unsub = store.onEvent((e) =>
        send({ ...e, symbol: e.mint ? store.token(e.mint)?.info.symbol : undefined, real: false, source: "demo" }),
      );
      const heartbeat = setInterval(() => send({ heartbeat: Date.now() }), 15_000);
      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsub();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
