import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AppError } from "../lib/errors.js";

function bundleError(message: string) {
  return new AppError("SKILL_BUNDLE_INVALID", message, { status: 503 });
}

function readBundle(sourceRoot: string) {
  const files: Array<{ relativePath: string; content: Buffer }> = [];

  function visit(directory: string) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) {
        files.push({
          relativePath: path.relative(sourceRoot, absolutePath).split(path.sep).join("/"),
          content: readFileSync(absolutePath),
        });
      } else {
        throw bundleError("Skill 包含无法分发的资源：" + entry.name);
      }
    }
  }

  visit(sourceRoot);
  const paths = new Set(files.map(file => file.relativePath));
  if (!paths.has("SKILL.md")) throw bundleError("Skill 缺少入口文件 SKILL.md，请重新构建。");

  for (const file of files.filter(file => file.relativePath.endsWith(".md"))) {
    for (const match of file.content.toString("utf8").matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].trim();
      if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const relativeTarget = target.startsWith("<")
        ? target.slice(1, target.indexOf(">"))
        : target.split(/\s+["']/)[0];
      const resource = decodeURIComponent(relativeTarget.split(/[?#]/)[0]);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.relativePath), resource));
      if (!paths.has(resolved)) throw bundleError("Skill 引用的资源不存在：" + resolved);
    }
  }

  return files;
}

/** Capture all resource bytes once, so the hash and snapshot always agree. */
export function snapshotSkillBundle({
  sourceRoot,
  destinationRoot,
  researchSessionId,
}: {
  sourceRoot: string;
  destinationRoot: string;
  researchSessionId: string;
}) {
  const files = readBundle(sourceRoot);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath).update("\0");
    hash.update(String(file.content.length)).update("\0");
    hash.update(file.content).update("\0");
  }
  const bundleHash = hash.digest("hex");
  const parent = path.join(destinationRoot, researchSessionId.replace(/[^a-zA-Z0-9_-]/g, "_"));
  const snapshotRoot = path.join(parent, bundleHash);

  function verifySnapshot() {
    const saved = readBundle(snapshotRoot);
    if (saved.length !== files.length || saved.some((file, index) =>
      file.relativePath !== files[index].relativePath || !file.content.equals(files[index].content),
    )) throw bundleError("Skill 快照资源与版本不一致，请重新生成会话快照。");
  }

  mkdirSync(parent, { recursive: true });
  if (existsSync(snapshotRoot)) verifySnapshot();
  else {
    const temporary = mkdtempSync(path.join(parent, ".skill-"));
    try {
      for (const file of files) {
        const target = path.join(temporary, ...file.relativePath.split("/"));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, file.content, { flag: "wx" });
      }
      try {
        renameSync(temporary, snapshotRoot);
      } catch (error) {
        // Another startup may have published the same complete version first.
        if (!existsSync(snapshotRoot)) throw error;
        verifySnapshot();
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  return { entryPath: path.join(snapshotRoot, "SKILL.md"), snapshotRoot, bundleHash };
}
