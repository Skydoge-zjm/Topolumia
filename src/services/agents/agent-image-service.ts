import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { AppError } from "../../lib/errors.js";
import { actorKey } from "../../domain/agents/agent-conversation.js";
import {
  imageViewPath,
  isImageView,
} from "../../domain/agents/agent-images.js";

export function imageType(header: Buffer): string | undefined {
  if (
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255)
    return "image/jpeg";
  if (/^GIF8[79]a$/.test(header.toString("ascii", 0, 6))) return "image/gif";
  if (
    header.toString("ascii", 0, 4) === "RIFF" &&
    header.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (header.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (
    header.toString("ascii", 4, 8) === "ftyp" &&
    /avif|avis/.test(header.toString("ascii", 8, 32))
  )
    return "image/avif";
}

/** The caller selects a recorded invocation, never an arbitrary filesystem path. */
export async function streamAgentImage(
  response,
  snapshot,
  eventId: string,
  cwd: string,
  mediaStore,
  variant = "original",
  request?,
) {
  const events = [
    ...(snapshot.conversationEvents ?? []),
    ...(snapshot.events ?? []),
  ];
  const reference = events.find(
    (event) => event.id === eventId && isImageView(event),
  );
  if (!reference)
    throw new AppError(
      "AGENT_IMAGE_NOT_FOUND",
      "会话中没有这次图像查看记录。",
      { status: 404 },
    );
  const callId = reference.payload.toolCallId ?? reference.payload.item?.id;
  const event = [...events]
    .reverse()
    .find(
      (event) =>
        event.turnId === reference.turnId &&
        actorKey(event.payload) === actorKey(reference.payload) &&
        (callId
          ? (event.payload.toolCallId ?? event.payload.item?.id) === callId
          : event.id === reference.id) &&
        imageViewPath(event),
    );
  const recordedPath = event && imageViewPath(event);
  if (
    !recordedPath ||
    recordedPath.includes("\0") ||
    /^(?:[a-z]+:\/\/|\\\\)/i.test(recordedPath)
  )
    throw new AppError(
      "AGENT_IMAGE_UNAVAILABLE",
      "该图像没有可读取的本地文件。",
      { status: 404 },
    );
  const captured = await mediaStore.snapshot(snapshot.id, event, cwd);
  await streamStoredAgentImage(request, response, await mediaStore.content(snapshot.id, captured.id, variant));
}

export async function streamStoredAgentImage(request, response, media) {
  const tag = `"${media.checksum}"`;
  const headers = { "etag": tag, "cache-control": "private, no-cache", "x-content-type-options": "nosniff" };
  if (request?.headers?.["if-none-match"] === tag) { response.writeHead(304, headers); response.end(); return; }
  response.writeHead(200, { ...headers, "content-type": media.mediaType, "content-length": media.sizeBytes, "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(media.name)}` });
  const handle = await open(media.file, "r");
  try { await pipeline(handle.createReadStream({ start: 0 }), response); } finally { await handle.close(); }
}
