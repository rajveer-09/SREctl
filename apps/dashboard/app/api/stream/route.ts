import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-Sent Events, not polling.
 *
 * Polling a REST endpoint on a timer is not real-time: it shows you a state on
 * a schedule of the client's choosing. SSE delivers the transition.
 *
 * Two details make this survive reality:
 *   - `Last-Event-ID` resumes from the exact sequence the client last saw, so
 *     a dropped connection replays nothing and skips nothing.
 *   - A periodic comment frame keeps proxies from closing an idle stream.
 */
export async function GET(request: Request): Promise<Response> {
  const store = getStore();

  const headerCursor = request.headers.get("last-event-id");
  const queryCursor = new URL(request.url).searchParams.get("from");
  let cursor = Number(headerCursor ?? queryCursor ?? 0);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      // Tell the browser how long to wait before reconnecting itself.
      send("retry: 3000\n\n");

      const tick = async () => {
        if (closed) return;
        try {
          const events = await store.since(cursor, 200);
          for (const { seq, event } of events) {
            cursor = seq;
            send(`id: ${seq}\nevent: srectl\ndata: ${JSON.stringify(event)}\n\n`);
          }
          if (events.length === 0) send(`: keep-alive ${Date.now()}\n\n`);
        } catch (err) {
          send(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
        }
      };

      await tick();
      const interval = setInterval(tick, 1500);

      // Without this the interval outlives the tab and the process leaks a
      // timer plus a database query loop per abandoned connection.
      request.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
