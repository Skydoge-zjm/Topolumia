import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationEvent } from "../domain/agents/agent-conversation.js";

export function sendSseEvent(
  response: ServerResponse,
  event: ConversationEvent,
) {
  return response.write(
    `id: ${event.cursor}\nevent: session\ndata: ${JSON.stringify(event)}\n\n`,
  );
}
export function eventIdPart(value: unknown, max = 120) {
  return (
    String(value ?? "unknown")
      .replace(/[^A-Za-z0-9_.:-]+/g, "-")
      .slice(0, max) || "unknown"
  );
}
type AccessGuard = {
  validate: () => void;
  subscribe?: (check: () => void) => () => void;
};
type EventGateway = {
  snapshot: (id: string) => unknown;
  subscribe: (
    id: string,
    listener: (event: ConversationEvent) => void,
    after: number,
  ) => () => void;
};

export function openSessionEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  gateway: EventGateway,
  sessionId: string,
  after: number,
  access?: AccessGuard,
) {
  access?.validate();
  gateway.snapshot(sessionId);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
  response.write("retry: 1200\n\n");
  let closed = false,
    blocked = false,
    bytes = 0;
  const queue: ConversationEvent[] = [];
  let unsubscribe = () => {},
    unwatch = () => {};
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    unsubscribe();
    unwatch();
    queue.length = 0;
    response.off("drain", drain);
  };
  const check = () => {
    if (closed) return false;
    try {
      access?.validate();
      return true;
    } catch {
      close();
      response.end("event: access.revoked\ndata: {}\n\n");
      return false;
    }
  };
  const send = (event: ConversationEvent) => {
    if (!check()) return;
    if (blocked) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > 1_048_576) {
        close();
        response.destroy();
        return;
      }
      queue.push(event);
      bytes += size;
      return;
    }
    blocked = !sendSseEvent(response, event);
  };
  const drain = () => {
    blocked = false;
    while (queue.length && !blocked && !closed) {
      const event = queue.shift()!;
      bytes -= Buffer.byteLength(JSON.stringify(event));
      send(event);
    }
  };
  response.on("drain", drain);
  unsubscribe = gateway.subscribe(sessionId, send, after);
  if (closed) unsubscribe();
  else {
    unwatch =
      access?.subscribe?.(() => {
        check();
      }) ?? (() => {});
    keepAlive = setInterval(() => {
      if (check() && !blocked) response.write(": keep-alive\n\n");
    }, 15_000);
    keepAlive.unref?.();
  }
  request.once("close", close);
  response.once("close", close);
}
