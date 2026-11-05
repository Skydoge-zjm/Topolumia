import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { runCommand } from "../../lib/command.js";

/**
 * Compile table fragments with file access restricted and shell escape disabled.
 * The original is kept independently of compilation and rendering.
 */
export async function compileTexTable(source, directory) {
  const tex = Buffer.from(source).toString("utf8");
  // Table imports do not need macros that read files, create commands, or run code.
  const forbidden = /\\(?:input|include|includeonly|openin|openout|read|write|immediate|catcode|csname|def|gdef|edef|xdef|newcommand|renewcommand|providecommand|usepackage|documentclass|loop|repeat|special|directlua|luaexec|pdfobj|pdfcatalog|pdfannot|pdfximage|pdfrefximage|shipout)\b/i;
  const table = tex.match(/\\begin\s*\{tabular\*?\}[\s\S]*?\\end\s*\{tabular\*?\}/)?.[0];
  if (!table) return { state: "failed", error: "没有找到可编译的 tabular 表格。" };
  if (forbidden.test(table) || table.length > 150_000) return { state: "failed", error: "表格包含不支持的 TeX 命令或超过编译长度限制。" };
  await mkdir(directory, { recursive: true });
  const wrapper = [
    "\\documentclass[border=8pt]{standalone}",
    "\\usepackage{booktabs,array,multirow,amsmath}",
    "\\usepackage[table]{xcolor}",
    "\\pagestyle{empty}",
    "\\begin{document}",
    table,
    "\\end{document}",
  ].join("\n");
  await writeFile(path.join(directory, "preview.tex"), wrapper, "utf8");
  const env = { ...process.env, openin_any: "p", openout_any: "p", max_print_line: "500", TEXMFOUTPUT: directory };
  const compiled = await runCommand("pdflatex", ["-no-shell-escape", "-halt-on-error", "-interaction=nonstopmode", "preview.tex"], { cwd: directory, env, timeoutMs: 20_000, killTree: true, maxOutputBytes: 250_000 });
  if (!compiled.ok) {
    const reason = compiled.stdout.split(/\r?\n/).filter(line => /^!/.test(line)).slice(0, 3).join(" ");
    return { state: "failed", error: reason || (compiled.timedOut ? "TeX 编译超时。" : "TeX 编译不可用或失败，请检查 pdflatex 安装及表格语法。") };
  }
  const rendered = await runCommand("pdftoppm", ["-f", "1", "-l", "1", "-singlefile", "-scale-to", "1600", "-png", "preview.pdf", "preview"], { cwd: directory, timeoutMs: 15_000, killTree: true, maxOutputBytes: 100_000 });
  return { state: "ready", pdf: "preview.pdf", image: rendered.ok ? "preview.png" : null, error: rendered.ok ? null : "PDF 已生成，图片预览不可用。" };
}
