import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  stat,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { AppError } from "../../lib/errors.js";
import { imageType } from "./agent-image-service.js";
import {
  MAX_AGENT_IMAGES,
  MAX_AGENT_IMAGE_BYTES,
  publicAgentAttachment,
  type StoredAgentImageAttachment,
} from "../../domain/agents/agent-attachments.js";
import {
  actorKey,
  type ConversationEvent,
} from "../../domain/agents/agent-conversation.js";
import { imageViewPath } from "../../domain/agents/agent-images.js";

type Media = StoredAgentImageAttachment & {
  checksum: string;
  createdAt: string;
  role: "draft" | "snapshot";
  width: number;
  height: number;
};
const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
};
const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
export class AgentAttachmentStore {
  readonly root: string;
  private pending = new Map<string, Promise<Media>>();
  private collectedAt = 0;
  constructor(historyFile: string) {
    this.root = path.join(path.dirname(historyFile), "attachments");
  }
  directory(sessionId: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId))
      throw new AppError("AGENT_SESSION_ID_INVALID", "Invalid session ID.", {
        status: 422,
      });
    return path.join(this.root, sessionId);
  }
  async manifest(sessionId: string, id: string): Promise<Media> {
    if (!validId(id))
      throw new AppError("AGENT_ATTACHMENTS_INVALID", "Invalid image ID.", {
        status: 422,
      });
    try {
      const media = JSON.parse(
        await readFile(
          path.join(this.directory(sessionId), `${id}.json`),
          "utf8",
        ),
      );
      if (media.id !== id || !extensions[media.mediaType])
        throw new Error("Invalid manifest");
      return {
        ...media,
        path: path.join(
          this.directory(sessionId),
          `${id}.${extensions[media.mediaType]}`,
        ),
      };
    } catch {
      throw new AppError(
        "AGENT_ATTACHMENT_NOT_FOUND",
        "没有找到当前会话中的图片，请重新添加。",
        { status: 404 },
      );
    }
  }
  private async store(
    sessionId: string,
    bytes: Buffer,
    name: string,
    role: Media["role"],
    id: string = randomUUID(),
  ): Promise<Media> {
    const mediaType = imageType(bytes.subarray(0, 32));
    if (!mediaType || !extensions[mediaType])
      throw new AppError(
        "AGENT_IMAGE_FORMAT_UNSUPPORTED",
        "请选择有效的图片。",
        { status: 415 },
      );
    const image = sharp(bytes, { limitInputPixels: 40_000_000 });
    let thumbnail: Buffer, dimensions;
    try {
      dimensions = await image.metadata();
      thumbnail = await image
        .rotate()
        .resize({
          width: 384,
          height: 288,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 78 })
        .toBuffer();
    } catch {
      throw new AppError(
        "AGENT_IMAGE_FORMAT_UNSUPPORTED",
        "图片无法解码或尺寸过大。",
        { status: 415 },
      );
    }
    const root = this.directory(sessionId);
    await mkdir(root, { recursive: true });
    const original = path.join(root, `${id}.${extensions[mediaType]}`);
    const media = {
      id,
      name,
      mediaType,
      sizeBytes: bytes.length,
      role,
      createdAt: new Date().toISOString(),
      checksum: createHash("sha256").update(bytes).digest("hex"),
      width: dimensions.width,
      height: dimensions.height,
    };
    const temporary = `${original}.${randomUUID()}.part`;
    try {
      await writeFile(temporary, bytes);
      await rename(temporary, original);
      await writeFile(path.join(root, `${id}.webp.thumb`), thumbnail);
      await writeFile(path.join(root, `${id}.json`), JSON.stringify(media));
    } finally {
      await rm(temporary, { force: true });
    }
    return { ...media, path: original };
  }
  async upload(
    request: AsyncIterable<Uint8Array> & { headers: Record<string, unknown> },
    sessionId: string,
  ) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_AGENT_IMAGE_BYTES)
        throw new AppError("AGENT_IMAGE_TOO_LARGE", "每张图片不能超过 5 MB。", {
          status: 413,
        });
      chunks.push(Buffer.from(chunk));
    }
    let name: string;
    try {
      name = decodeURIComponent(
        String(request.headers["x-image-name"] ?? "image.png"),
      );
    } catch {
      throw new AppError("AGENT_IMAGE_NAME_INVALID", "图片名称无效。", {
        status: 422,
      });
    }
    name =
      [...name.replace(/\\/g, "/").split("/").at(-1)!]
        .filter(
          (char) => char.codePointAt(0)! >= 32 && char.codePointAt(0) !== 127,
        )
        .join("")
        .slice(0, 200) || "image.png";
    const media = await this.store(
      sessionId,
      Buffer.concat(chunks),
      name,
      "draft",
    );
    return publicAgentAttachment(media);
  }
  async resolve(sessionId: string, ids: unknown = []) {
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_AGENT_IMAGES ||
      ids.some((id) => !validId(id)) ||
      new Set(ids).size !== ids.length
    )
      throw new AppError(
        "AGENT_ATTACHMENTS_INVALID",
        "每条消息最多附加 8 张图片。",
        { status: 422 },
      );
    const media = await Promise.all(
      ids.map((id) => this.manifest(sessionId, id)),
    );
    for (const image of media) {
      try {
        await stat(image.path);
      } catch {
        throw new AppError(
          "AGENT_ATTACHMENT_NOT_FOUND",
          "图片文件缺失，请重新添加。",
          { status: 404 },
        );
      }
    }
    return media;
  }
  async snapshot(
    sessionId: string,
    event: ConversationEvent,
    cwd: string,
  ): Promise<Media> {
    const raw = imageViewPath(event);
    if (!raw || raw.includes("\0") || /^(?:[a-z]+:\/\/|\\\\)/i.test(raw))
      throw new AppError("AGENT_IMAGE_UNAVAILABLE", "没有可读取的本地图像。", {
        status: 404,
      });
    const hash = createHash("sha256")
      .update(
        `${event.turnId}:${actorKey(event.payload)}:${event.payload.toolCallId ?? (event.payload.item as { id?: string })?.id ?? event.id}`,
      )
      .digest("hex")
      .slice(0, 32);
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
    try {
      return await this.manifest(sessionId, id);
    } catch {
      /* Capture once, then retain the immutable image. */
    }
    const key = `${sessionId}:${id}`;
    if (!this.pending.has(key))
      this.pending.set(
        key,
        (async () => {
          const file = path.resolve(cwd, raw);
          let bytes: Buffer;
          try {
            const info = await stat(file);
            if (!info.isFile() || info.size > 40 * 1024 * 1024)
              throw new Error("Image size invalid");
            bytes = await readFile(file);
          } catch {
            throw new AppError(
              "AGENT_IMAGE_UNAVAILABLE",
              "图像文件已移除或无法读取。",
              { status: 404 },
            );
          }
          return this.store(
            sessionId,
            bytes,
            path.basename(raw),
            "snapshot",
            id,
          );
        })().finally(() => this.pending.delete(key)),
      );
    return this.pending.get(key)!;
  }
  async content(sessionId: string, id: string, variant = "original") {
    const media = await this.manifest(sessionId, id);
    if (!["original", "thumbnail"].includes(variant))
      throw new AppError(
        "AGENT_IMAGE_VARIANT_INVALID",
        "Unknown image variant.",
        { status: 422 },
      );
    const thumbnail = variant === "thumbnail";
    const file = thumbnail
      ? path.join(this.directory(sessionId), `${id}.webp.thumb`)
      : media.path;
    const info = await stat(file).catch(() => {
      throw new AppError("AGENT_IMAGE_UNAVAILABLE", "图像文件无法读取。", {
        status: 404,
      });
    });
    return {
      ...media,
      file,
      mediaType: thumbnail ? "image/webp" : media.mediaType,
      sizeBytes: info.size,
      checksum: `${media.checksum}:${variant}`,
    };
  }
  async removeDraft(sessionId: string, id: string, references: Set<string>) {
    const media = await this.manifest(sessionId, id);
    if (media.role !== "draft" || references.has(id))
      throw new AppError(
        "AGENT_ATTACHMENT_REFERENCED",
        "已发送的图片保留在会话中。",
        { status: 409 },
      );
    for (const suffix of [
      `${id}.json`,
      `${id}.${extensions[media.mediaType]}`,
      `${id}.webp.thumb`,
    ])
      await rm(path.join(this.directory(sessionId), suffix), { force: true });
  }
  async collect(
    source:
      | Array<{
          id: string;
          turns?: Array<{ attachments?: Array<{ id: string }> }>;
          queuedMessages?: Array<{ attachments?: Array<{ id: string }> }>;
        }>
      | (() => Array<{
          id: string;
          turns?: Array<{ attachments?: Array<{ id: string }> }>;
          queuedMessages?: Array<{ attachments?: Array<{ id: string }> }>;
        }>),
    now = Date.now(),
  ) {
    if (now - this.collectedAt < 3_600_000) return;
    this.collectedAt = now;
    const sessions = typeof source === "function" ? source() : source;
    const references = new Map(
      sessions.map((session) => [
        session.id,
        new Set(
          [...(session.turns ?? []), ...(session.queuedMessages ?? [])].flatMap(
            (message) => (message.attachments ?? []).map((image) => image.id),
          ),
        ),
      ]),
    );
    for (const session of await readdir(this.root, {
      withFileTypes: true,
    }).catch(() => [])) {
      if (!session.isDirectory()) continue;
      for (const name of await readdir(this.directory(session.name)))
        if (name.endsWith(".json")) {
          try {
            const media = await this.manifest(session.name, name.slice(0, -5));
            if (
              media.role === "draft" &&
              now - Date.parse(media.createdAt) > 86_400_000 &&
              !references.get(session.name)?.has(media.id)
            )
              await this.removeDraft(session.name, media.id, new Set());
          } catch {
            /* Keep unreadable files for inspection. */
          }
        }
    }
  }
  async close() {
    await Promise.allSettled(this.pending.values());
  }
}
