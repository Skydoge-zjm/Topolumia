import { readFile, stat } from "node:fs/promises";

import path from "node:path";

import { AppError } from "../lib/errors.js";
import { mimeTypes } from "../lib/http.js";
import { isPathInside } from "../adapters/sources/filesystem-adapter.js";

export function securityHeaders(contentType) {
  return {
    "content-type": contentType,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'",
  };
}

export async function sendStatic(
  response,
  publicRoot,
  pathname,
  headOnly = false,
) {
  let requested;
  try {
    requested = decodeURIComponent(
      pathname === "/" ? "index.html" : pathname.slice(1),
    );
  } catch {
    throw new AppError("INVALID_PATH", "静态资源路径无效。", { status: 400 });
  }
  const filePath = path.resolve(publicRoot, requested);
  if (!isPathInside(publicRoot, filePath)) {
    throw new AppError("STATIC_PATH_OUTSIDE_ROOT", "静态资源路径越界。", {
      status: 403,
    });
  }
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new AppError("NOT_FOUND", "未找到资源。", { status: 404 });
  }
  if (!fileStat.isFile())
    throw new AppError("NOT_FOUND", "未找到资源。", { status: 404 });
  const body = headOnly ? null : await readFile(filePath);
  const contentType =
    mimeTypes.get(path.extname(filePath).toLowerCase()) ??
    "application/octet-stream";
  response.writeHead(200, {
    ...securityHeaders(contentType),
    "content-length": fileStat.size,
  });
  response.end(body);
}

export function sendSvg(response, content) {
  const body = Buffer.from(String(content ?? ""), "utf8");
  response.writeHead(200, {
    ...securityHeaders("image/svg+xml"),
    "content-length": body.length,
  });
  response.end(body);
}
