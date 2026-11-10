import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import { AppError } from "../../lib/errors.js";

const textExtensions = new Set([".md", ".txt", ".yaml", ".yml", ".json", ".py"]);
const ignoredNames = new Set([".git", "node_modules", ".cache", "__pycache__", ".env", ".topolumia", ".topolumia-transfer", ".topolumia-skills", ".codex", ".claude", ".opencode"]);

export type IndexedFile = {
  ref: string; source: string; kind: string; externalId: string; version: string; label: string;
  locator: string; observedAt: string; relativePath: string; extension: string; size: number; hash: string;
  excerpt: string | null; capabilities: { text: boolean; values: boolean; original: boolean };
};
type TextEntry = { version: string; text: string };
type WalkContext = {
  files: IndexedFile[]; skipped: { symlink: number; extension: number; tooLargeForExcerpt: number; limit: number; inaccessible: number };
  allowedExtensions: Set<string>; projectRoot: string; textIndex: Map<string, TextEntry>;
};
export function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function normalizeRelative(value: string) {
  return value.split(path.sep).join("/");
}

export class FilesystemAdapter {
  readonly id = "filesystem-local";
  textIndex = new Map<string, TextEntry>();
  constructor(public config: AppConfig) {}

  isResearchPath(file: unknown) {
    if (typeof file !== "string") return false;
    const resolved = path.resolve(file);
    if ((this.config.filesystem.excludedRoots ?? []).some(root => isPathInside(root, resolved))) return false;
    return this.config.filesystem.roots.some(root => isPathInside(root, resolved) &&
      !path.relative(root, resolved).split(path.sep).some(part => ignoredNames.has(part)));
  }

  async readIndexedText(source: Pick<IndexedFile, "extension" | "locator" | "version" | "ref">) {
    if (!textExtensions.has(source.extension)) return { text: null, totalChars: null, complete: false };
    let filePath;
    try { filePath = await realpath(source.locator); }
    catch { throw new AppError("SOURCE_UNAVAILABLE", "Indexed source is no longer available. Refresh project sources.", { status: 409 }); }
    const roots = await Promise.all(this.config.filesystem.roots.map((root) => realpath(root).catch(() => null)));
    if (!this.isResearchPath(filePath) || !roots.some((root) => root && isPathInside(root, filePath))) throw new AppError("SOURCE_SCOPE_FORBIDDEN", "Source is outside the research material roots.", { status: 403 });
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.size > this.config.filesystem.maxTextBytes) return { text: null, totalChars: null, complete: false };
    const bytes = await readFile(filePath);
    if (bytes.length > this.config.filesystem.maxTextBytes) return { text: null, totalChars: null, complete: false };
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== source.version) throw new AppError("SOURCE_VERSION_CONFLICT", "Source content changed since indexing. Refresh sources before reading or citing it.", { status: 409 });
    const text = bytes.toString("utf8");
    this.textIndex.set(source.ref, { version: source.version, text });
    return { text, totalChars: text.length, complete: true };
  }

  indexedText(source: Pick<IndexedFile, "version" | "ref">) {
    const entry = this.textIndex.get(source.ref);
    return entry && entry.version === source.version ? entry.text : null;
  }

  async health() {
    const checkedAt = new Date().toISOString();
    const roots = [];
    for (const root of this.config.filesystem.roots) {
      try {
        const stat = await lstat(root);
        roots.push({ root, available: stat.isDirectory() });
      } catch {
        roots.push({ root, available: false });
      }
    }
    const available = roots.filter((root) => root.available).length;
    return {
      status: available === roots.length ? "ready" : available > 0 ? "degraded" : "unavailable",
      detail: `${available}/${roots.length} allowlisted roots available`,
      checkedAt,
    };
  }

  async descriptor() {
    return {
      id: this.id,
      kind: "source",
      provider: "filesystem",
      label: "local filesystem",
      mode: "live",
      capabilities: ["health", "snapshot", "excerpt", "content-hash"],
      health: await this.health(),
    };
  }

  async snapshot() {
    const observedAt = new Date().toISOString();
    const files: IndexedFile[] = [];
    const textIndex = new Map<string, TextEntry>();
    const skipped = { symlink: 0, extension: 0, tooLargeForExcerpt: 0, limit: 0, inaccessible: 0 };
    const allowedExtensions = new Set(this.config.filesystem.allowedExtensions.map((item) => item.toLowerCase()));
    const projectRoot = path.resolve(this.config.project.root);

    for (const root of [...this.config.filesystem.roots].sort()) {
      if (!isPathInside(projectRoot, root)) {
        throw new AppError("FILESYSTEM_ROOT_OUTSIDE_PROJECT", "filesystem allowlist 超出项目根目录。", {
          status: 500,
          detail: { root },
        });
      }
      try {
        const rootStat = await lstat(root);
        if (rootStat.isSymbolicLink()) {
          skipped.symlink += 1;
          continue;
        }
        if (!rootStat.isDirectory()) {
          skipped.inaccessible += 1;
          continue;
        }
      } catch {
        skipped.inaccessible += 1;
        continue;
      }
      await this.#walk(root, 0, { files, skipped, allowedExtensions, projectRoot, textIndex });
      if (files.length >= this.config.filesystem.maxFiles) break;
    }

    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    this.textIndex = textIndex;
    return {
      source: this.id,
      observedAt,
      roots: this.config.filesystem.roots.map((root) => normalizeRelative(path.relative(projectRoot, root))),
      files,
      skipped,
    };
  }

  async #walk(directory: string, depth: number, context: WalkContext): Promise<void> {
    if (depth > this.config.filesystem.maxDepth) return;
    if (context.files.length >= this.config.filesystem.maxFiles) {
      context.skipped.limit += 1;
      return;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      context.skipped.inaccessible += 1;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (context.files.length >= this.config.filesystem.maxFiles) {
        context.skipped.limit += 1;
        break;
      }
      if (ignoredNames.has(entry.name)) continue;
      const candidate = path.resolve(directory, entry.name);
      if (!this.isResearchPath(candidate)) continue;
      if (!isPathInside(context.projectRoot, candidate)) {
        context.skipped.inaccessible += 1;
        continue;
      }

      let stat;
      try {
        stat = await lstat(candidate);
      } catch {
        context.skipped.inaccessible += 1;
        continue;
      }
      if (stat.isSymbolicLink()) {
        context.skipped.symlink += 1;
        continue;
      }
      if (stat.isDirectory()) {
        await this.#walk(candidate, depth + 1, context);
        continue;
      }
      if (!stat.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase();
      if (!context.allowedExtensions.has(extension)) {
        context.skipped.extension += 1;
        continue;
      }
      let hash = await hashFile(candidate);
      const relativePath = normalizeRelative(path.relative(context.projectRoot, candidate));
      let excerpt: string | null = null;
      if (textExtensions.has(extension)) {
        if (stat.size <= this.config.filesystem.maxTextBytes) {
          const bytes = await readFile(candidate);
          if (bytes.length <= this.config.filesystem.maxTextBytes) {
            const text = bytes.toString("utf8");
            hash = createHash("sha256").update(bytes).digest("hex");
            excerpt = text.slice(0, this.config.filesystem.excerptChars);
            context.textIndex.set(`file:${relativePath}`, { version: `sha256:${hash}`, text });
          }
        } else {
          context.skipped.tooLargeForExcerpt += 1;
        }
      }
      context.files.push({
        ref: `file:${relativePath}`,
        source: this.id,
        kind: extension === ".pdf" ? "paperAttachment" : "artifact",
        externalId: relativePath,
        version: `sha256:${hash}`,
        label: entry.name,
        locator: candidate,
        observedAt: new Date(stat.mtimeMs).toISOString(),
        relativePath,
        extension,
        size: stat.size,
        hash,
        excerpt,
        capabilities: { text: context.textIndex.has(`file:${relativePath}`), values: false, original: true },
      });
    }
  }
}
