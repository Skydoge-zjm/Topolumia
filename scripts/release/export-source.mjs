import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rootFiles = new Set([
  ".gitattributes", ".gitignore", ".node-version", "README.md", "AGENTS.md", "CLAUDE.md", "DESIGN.md", "LICENSE",
  "package.json", "package-lock.json", "tsconfig.backend.json",
  "tsconfig.backend.check.json", "eslint.backend.config.js",
]);
const sourceDirectories = new Set([
  ".github", "bin", "config", "fixtures", "frontend", "managed-wrappers",
  "requirements", "scripts", "src", "tests", "docs",
]);
const documentationSections = new Set(["product", "technical", "playbooks"]);
const privateDirectories = /^(?:\.git|node_modules|runtime|workspaces|dist|artifacts|coverage|test-results|playwright-report|__pycache__|credentials|secrets|\.codex|\.claude|\.opencode|\.idea|\.vscode|\.venv[^/]*|\.test-runtime|\.topolumia-transfer|\.topolumia-skills)$/i;
const privateFiles = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|.*\.(?:log|pem|key|p12|pfx|jks|sqlite(?:-.*)?|db(?:-.*)?|tsbuildinfo)|\.DS_Store|Thumbs\.db)$/i;

function included(relative, directory) {
  const parts = relative.split("/");
  if (parts.some((part, index) => privateFiles.test(part) ||
    privateDirectories.test(part) && !(index === 1 && parts[0] === "scripts" && part === "runtime"))) return false;
  if (parts.length === 1 && !directory) return rootFiles.has(relative);
  if (!sourceDirectories.has(parts[0])) return false;
  if (parts[0] === "docs") return parts.length === 1 && directory ||
    parts.length === 2 && parts[1] === "README.md" && !directory || documentationSections.has(parts[1]);
  if (directory) return true;
  if (parts[0] === "config") return parts.length === 2 && parts[1].endsWith(".example.json");
  // Markdown under fixtures is synthetic research input used by the app/tests.
  if (/\.(?:md|mdx|rst)$/i.test(relative) && !relative.startsWith("fixtures/research/") && !relative.startsWith("src/agent/skills/topolumia-paper-reading/")) return false;
  return !["scripts/align_wordmark_colors.py", "scripts/clean_wordmark.py"].includes(relative);
}

export async function exportSource(sourceRoot = repositoryRoot) {
  const root = await lstat(sourceRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Expected a real source directory.");
  for (const required of ["README.md", "package.json", "package-lock.json"]) {
    if (!(await lstat(path.join(sourceRoot, required))).isFile()) throw new Error(`Missing ${required}.`);
  }
  const outputParent = path.join(sourceRoot, "artifacts", "github");
  // Never traverse a pre-existing link when creating or replacing generated output.
  for (const directory of [path.join(sourceRoot, "artifacts"), outputParent]) {
    await mkdir(directory).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Source output must stay inside the workspace.");
  }
  const destination = path.join(outputParent, "topolumia");
  const manifestPath = path.join(outputParent, "source-manifest.json");
  const previous = await lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (previous) {
    if (!previous.isDirectory() || previous.isSymbolicLink()) throw new Error("Refusing to replace a linked source export.");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.format !== "topolumia-source.v1") throw new Error("Refusing to replace an unrecognized directory.");
  }
  const temporary = await mkdtemp(path.join(outputParent, ".source-"));
  const files = [];
  async function copy(relative = "") {
    const current = path.join(sourceRoot, relative);
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!included(name, entry.isDirectory())) continue;
      const info = await lstat(path.join(sourceRoot, name));
      if (info.isSymbolicLink()) throw new Error(`Source links must be reviewed before export: ${name}`);
      if (info.isDirectory()) { await copy(name); continue; }
      if (!info.isFile()) throw new Error(`Unsupported source entry: ${name}`);
      const content = await readFile(path.join(sourceRoot, name));
      const target = path.join(temporary, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      await chmod(target, name === "bin/topolumia" ? 0o755 : 0o644);
      files.push({ path: name, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
    }
  }
  try {
    await copy();
    const manifest = { format: "topolumia-source.v1", files, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
    // Both paths are fixed children of the verified outputParent above.
    if (previous) await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return { destination, manifestPath, fileCount: files.length, bytes: manifest.totalBytes,
      licenseIncluded: files.some(file => file.path === "LICENSE") };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await exportSource(), null, 2));
}
