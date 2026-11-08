import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { brotliCompress, gzip, constants } from "node:zlib";
import { promisify } from "node:util";

import path from "node:path";

import { AppError } from "../lib/errors.js";
import { mimeTypes } from "../lib/http.js";
import { isPathInside } from "../adapters/sources/filesystem-adapter.js";

const compressBr = promisify(brotliCompress), compressGzip = promisify(gzip);
const files = new Map();
let cachedBytes = 0;
const tagged = body => ({ body, etag: `"${createHash("sha256").update(body).digest("base64url")}"` });
function trimCache() {
  while (cachedBytes > 32 * 1024 * 1024 || files.size > 256) {
    const first = files.keys().next().value;
    cachedBytes -= files.get(first).bytes;
    files.delete(first);
  }
}
function quality(header, encoding) {
  const values = new Map(String(header ?? "").split(",").filter(Boolean).map(part => {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    const parameter = parameters.find(value => value.trim().startsWith("q="));
    const q = parameter ? Number(parameter.trim().slice(2)) : 1;
    return [name, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0];
  }));
  return values.get(encoding) ?? (encoding === "identity" ? (values.get("*") === 0 ? 0 : 1) : values.get("*") ?? 0);
}
async function representation(filePath, info, encoding) {
  const version = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  let entry = files.get(filePath);
  if (!entry || entry.version !== version) {
    const body = await readFile(filePath);
    if (files.has(filePath)) { cachedBytes -= files.get(filePath).bytes; files.delete(filePath); }
    entry = { version, bytes: body.length, variants: new Map([["identity", Promise.resolve(tagged(body))]]) };
    files.set(filePath, entry);
    cachedBytes += entry.bytes;
    trimCache();
  } else { files.delete(filePath); files.set(filePath, entry); }
  if (!entry.variants.has(encoding)) {
    const pending = entry.variants.get("identity").then(({ body }) => encoding === "br"
      ? compressBr(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
      : compressGzip(body)).then(body => {
        if (files.get(filePath) === entry) { entry.bytes += body.length; cachedBytes += body.length; trimCache(); }
        return tagged(body);
      });
    entry.variants.set(encoding, pending);
  }
  return entry.variants.get(encoding);
}

export function securityHeaders(contentType) {
  return {
    "content-type": contentType,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:",
  };
}

export async function sendStatic(
  request,
  response,
  publicRoot,
  pathname,
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
  const contentType =
    mimeTypes.get(path.extname(filePath).toLowerCase()) ??
    "application/octet-stream";
  const compressible = /\.(?:html|css|js|json|svg)$/i.test(filePath) && fileStat.size >= 1024;
  const accepted = request.headers["accept-encoding"];
  const encodings = compressible ? ["br", "gzip", "identity"] : ["identity"];
  const encoding = encodings.map(name => ({ name, q: quality(accepted, name) })).sort((a, b) => b.q - a.q).find(item => item.q > 0)?.name;
  if (!encoding) throw new AppError("NOT_ACCEPTABLE", "没有可接受的资源编码。", { status: 406 });
  const { body, etag } = await representation(filePath, fileStat, encoding);
  const headers = {
    ...securityHeaders(contentType),
    "cache-control": /^assets\/.+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(requested.replaceAll("\\", "/")) ? "public, max-age=31536000, immutable" : "no-cache",
    etag,
    "last-modified": fileStat.mtime.toUTCString(),
    ...(compressible ? { vary: "Accept-Encoding" } : {}),
    ...(encoding !== "identity" ? { "content-encoding": encoding } : {}),
  };
  const noneMatch = request.headers["if-none-match"];
  const unchanged = noneMatch !== undefined
    ? String(noneMatch).split(",").some(tag => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag)
    : Number.isFinite(Date.parse(request.headers["if-modified-since"])) && Math.floor(fileStat.mtimeMs / 1000) * 1000 <= Date.parse(request.headers["if-modified-since"]);
  if (unchanged) { response.writeHead(304, headers); response.end(); return; }
  response.writeHead(200, { ...headers, "content-length": body.length });
  response.end(request.method === "HEAD" ? null : body);
}

export function sendSvg(response, content) {
  const body = Buffer.from(String(content ?? ""), "utf8");
  response.writeHead(200, {
    ...securityHeaders("image/svg+xml"),
    "content-length": body.length,
  });
  response.end(body);
}
