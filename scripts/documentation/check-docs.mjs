import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const slash = value => value.split(path.sep).join("/");
const exists = async file => {
  try { return await stat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};

function prose(markdown) {
  let fence = null;
  return markdown.split(/\r?\n/).map(line => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return "";
    }
    return fence ? "" : line;
  }).join("\n");
}

function anchors(markdown) {
  const ids = new Set(), counts = new Map();
  for (const match of prose(markdown).matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, "").toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/\s/g, "-");
    const count = counts.get(base) ?? 0;
    ids.add(base + (count ? `-${count}` : ""));
    counts.set(base, count + 1);
  }
  for (const match of markdown.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) ids.add(match[1]);
  return ids;
}

function links(markdown) {
  const text = prose(markdown).replace(/`[^`\n]+`/g, "");
  const result = [...text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g)]
    .map(match => match[1].replace(/^<|>$/g, ""));
  // Claude Code's native import is deliberately just a bridge to the shared entry.
  for (const match of text.matchAll(/^@(\S+\.md)\s*$/gm)) result.push(match[1]);
  return result;
}

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "references", "work", "node_modules"].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(file));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(file);
  }
  return files.sort();
}

export async function checkDocumentation(root = sourceRoot) {
  root = path.resolve(root);
  const docs = path.join(root, "docs"), hasDocumentation = Boolean((await exists(docs))?.isDirectory());
  const errors = [], files = [], contents = new Map(), graph = new Map();
  const display = file => slash(path.relative(root, file));
  if (!hasDocumentation) errors.push("缺少正式文档目录：docs。");
  for (const name of ["README.md", "AGENTS.md", "CLAUDE.md"]) {
    const file = path.join(root, name);
    if (await exists(file)) files.push(file);
    else errors.push(`缺少入口：${name}`);
  }
  for (const name of ["DESIGN.md", "CONTRIBUTING.md", "SECURITY.md", ".github/PULL_REQUEST_TEMPLATE.md"]) {
    const file = path.join(root, name);
    if (await exists(file)) files.push(file);
  }
  if (hasDocumentation) {
    const required = ["README.md", "product/overview.md", "product/business", "product/requirements",
      "technical/overview.md", "technical/architecture", "technical/modules", "technical/decisions",
      "playbooks/documentation.md"];
    for (const name of required) if (!await exists(path.join(docs, name))) errors.push(`缺少文档入口：docs/${name}`);
    for (const name of ["design", "specifications", "archive", "validation", "proposals"])
      if (await exists(path.join(docs, name))) errors.push(`旧文档目录仍在现行知识库：docs/${name}`);
    files.push(...await markdownFiles(docs));
  }
  for (const file of files) contents.set(file, await readFile(file, "utf8"));
  const budgets = { "AGENTS.md": [80, 4500], "CLAUDE.md": [10, 500], "docs/README.md": [120, 8000] };
  for (const [name, [lines, chars]] of Object.entries(budgets)) {
    const text = contents.get(path.join(root, name));
    if (text !== undefined && (text.trimEnd().split(/\r?\n/).length > lines || [...text].length > chars))
      errors.push(`常驻入口超预算：${name}（最多 ${lines} 行 / ${chars} 字符）`);
  }
  const bridge = contents.get(path.join(root, "CLAUDE.md"));
  if (bridge !== undefined && !/^@AGENTS\.md\s*$/m.test(bridge)) errors.push("CLAUDE.md 必须导入共同入口 @AGENTS.md。");
  const entry = contents.get(path.join(root, "AGENTS.md"));
  if (entry !== undefined && !links(entry).includes("docs/README.md")) errors.push("AGENTS.md 缺少 docs/README.md 导航。");

  let checkedLinks = 0;
  for (const [file, markdown] of contents) {
    const outgoing = new Set(); graph.set(file, outgoing);
    for (const target of links(markdown)) {
      if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[/\\]/i.test(target)) continue;
      checkedLinks++;
      if (/^(?:[a-z]:[/\\]|[/\\])/i.test(target)) { errors.push(`${display(file)}：使用相对链接：${target}`); continue; }
      let decoded;
      try { decoded = decodeURIComponent(target); }
      catch { errors.push(`${display(file)}：无效链接编码：${target}`); continue; }
      const hash = decoded.indexOf("#"), fragment = hash < 0 ? "" : decoded.slice(hash + 1);
      const resource = (hash < 0 ? decoded : decoded.slice(0, hash)).split("?")[0];
      const resolved = resource ? path.resolve(path.dirname(file), resource) : file;
      const relative = path.relative(root, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        errors.push(`${display(file)}：链接越出项目：${target}`); continue;
      }
      if (/^docs\/(?:work|references)(?:\/|$)/.test(slash(relative))) {
        errors.push(`${display(file)}：正式文档不能依赖本机资料：${target}`); continue;
      }
      const info = await exists(resolved);
      if (!info) { errors.push(`${display(file)}：链接不存在：${target}`); continue; }
      outgoing.add(resolved);
      if (fragment && info.isFile() && resolved.endsWith(".md")) {
        const body = contents.get(resolved) ?? await readFile(resolved, "utf8");
        if (!anchors(body).has(fragment)) errors.push(`${display(file)}：锚点不存在：${target}`);
      }
    }
  }
  if (hasDocumentation) {
    const reachable = new Set(), pending = [path.join(docs, "README.md")];
    while (pending.length) {
      const file = pending.pop();
      if (reachable.has(file)) continue;
      reachable.add(file);
      for (const next of graph.get(file) ?? []) if (contents.has(next)) pending.push(next);
    }
    for (const file of contents.keys()) {
      const name = slash(path.relative(docs, file));
      if (name.startsWith("../")) continue;
      if (!reachable.has(file)) errors.push(`导航不可达：docs/${name}`);
    }
  }
  return { files: files.length, checkedLinks, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length) {
    process.stderr.write("Usage: npm run docs:check\n");
    process.exitCode = 2;
  } else {
    const result = await checkDocumentation(sourceRoot);
    for (const error of result.errors) process.stderr.write(error + "\n");
    process.stdout.write(`项目文档：${result.files} 份文档，${result.checkedLinks} 个本地链接，${result.errors.length} 个问题。\n`);
    process.exitCode = result.errors.length ? 1 : 0;
  }
}
