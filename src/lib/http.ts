import type * as z from "zod/v4";
import { AppError } from "./errors.js";
import type { ServerResponse } from "node:http";
import type { Readable } from "node:stream";

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export async function readJson(request: Readable, maxBytes = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.length;
    if (total > maxBytes) {
      throw new AppError("BODY_TOO_LARGE", "请求内容超过允许大小。", { status: 413 });
    }
    chunks.push(bytes);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new AppError("INVALID_JSON", "请求体不是有效 JSON。", {
      status: 400,
      detail: { reason: error instanceof Error ? error.message : String(error) },
    });
  }
}

export function parseInput<T>(schema: z.ZodType<T>, value: unknown, code = "INPUT_INVALID"): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(code, "请求参数无效。", { status: 422, detail: { issues: parsed.error.issues } });
  return parsed.data;
}
export function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new AppError("INPUT_INVALID", "需要字符串参数。", { status: 422 });
  return value;
}
/** Object-shaped JSON for routes that validate individual fields or delegate to a schema. */
export async function readJsonObject(request: Readable, maxBytes = 1_048_576): Promise<Record<string, unknown>> {
  const value = await readJson(request, maxBytes);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AppError("INPUT_INVALID", "请求体必须是 JSON 对象。", { status: 422 });
  return value as Record<string, unknown>;
}
export function headerValue(request: { headers: Record<string, string | string[] | undefined> }, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webp", "image/webp"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
]);
