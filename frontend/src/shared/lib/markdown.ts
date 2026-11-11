import katex from "katex";
import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import r from "highlight.js/lib/languages/r";
import sql from "highlight.js/lib/languages/sql";
for (const [name, language] of Object.entries({
  python,
  javascript,
  typescript,
  bash,
  json,
  yaml,
  r,
  sql,
}))
  hljs.registerLanguage(name, language);
const aliases: Record<string, string> = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  sh: "bash",
  yml: "yaml",
};
const codeCache = new Map<string, string>();
const extensions: Record<string, string> = {
  py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  sh: "bash", bash: "bash", zsh: "bash", json: "json", jsonl: "json", yaml: "yaml", yml: "yaml", r: "r", sql: "sql",
};
/** The registered highlighter language for a declared language or a file name, if any. */
export function codeLanguage(language?: string, filename?: string): string | undefined {
  const declared = (language ?? "").trim().toLowerCase(), extension = /\.([a-z0-9]+)$/i.exec(filename ?? "")?.[1]?.toLowerCase();
  for (const name of [aliases[declared] ?? declared, extension ? extensions[extension] : ""]) if (name && hljs.getLanguage(name)) return name;
  return undefined;
}
/** Escaped HTML for a code listing; unknown languages and very long listings stay plain. */
export function highlightCode(code: string, language?: string): string {
  return language && code.length < 40_000 && hljs.getLanguage(language)
    ? hljs.highlight(code, { language, ignoreIllegals: true }).value
    : escapeHtml(code);
}
const math = (value: string, displayMode = false) =>
  katex.renderToString(value, {
    displayMode,
    throwOnError: false,
    trust: false,
    strict: "ignore",
    maxExpand: 500,
    maxSize: 20,
    output: "htmlAndMathml",
  });

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[char] ?? char,
  );
}

function safeLink(value: string): string | null {
  const decoded = value.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  return /^https?:\/\//i.test(decoded) ? decoded.replace(/"/g, "%22") : null;
}

function renderInline(value: string): string {
  const codeSpans: string[] = [];
  const protectedText = value.replace(
    /`([^`\n]+)`|\\\((.+?)\\\)|(?<!\\)\$([^\n$]+?)\$/g,
    (match, code?: string, inlineMath?: string, dollarMath?: string) => {
      const token = `\u0000CODE${codeSpans.length}\u0000`;
      codeSpans.push(
        code !== undefined
          ? `<code>${escapeHtml(code)}</code>`
          : math(inlineMath ?? dollarMath ?? match),
      );
      return token;
    },
  );
  let output = escapeHtml(protectedText);
  output = output.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, alt: string, url: string) => {
      const safe = safeLink(url);
      return safe
        ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${alt}</a>`
        : alt;
    },
  );
  output = output.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, label: string, url: string) => {
      if (/^(file|git|mlflow|wandb|tensorboard):[^/]/i.test(url))
        return `<button type="button" class="research-source-link" data-source-ref="${url}">${label}</button>`;
      const safe = safeLink(url);
      return safe
        ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label;
    },
  );
  output = output.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  output = output.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  output = output.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  output = output.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
  output = output.replace(
    // eslint-disable-next-line no-control-regex -- NUL-delimited placeholders protect inline code from formatting.
    /\u0000CODE(\d+)\u0000/g,
    (_match, index: string) => codeSpans[Number(index)] ?? "",
  );
  return output;
}

function isTableSeparator(line: string): boolean {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return (
    cells.length > 1 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))
  );
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderList(lines: string[], ordered: boolean): string {
  const tag = ordered ? "ol" : "ul";
  const items = lines
    .map((line) => {
      const match = line.match(
        ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-+*]\s+(.*)$/,
      );
      const text = match?.[1] ?? line.trim();
      const task = text.match(/^\[([ xX])\]\s+(.*)$/);
      if (task)
        return `<li class="task-item"><input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""} /> ${renderInline(task[2])}</li>`;
      return `<li>${renderInline(text)}</li>`;
    })
    .join("");
  return `<${tag}>${items}</${tag}>`;
}

export function renderReasoningSummary(value: string): string {
  // Some providers send adjacent bold summary headings with no whitespace.
  // Separate those rendered headings without changing the stored source text.
  return renderMarkdown(value).replace(
    /<\/strong><strong>/g,
    "</strong><br /><strong>",
  );
}

export function renderMarkdown(
  value: string,
  options: { en?: boolean; highlight?: boolean } = {},
): string {
  const source = String(value ?? "").replace(/\r\n?/g, "\n");
  if (!source.trim()) return "";
  const lines = source.split("\n");
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.trim().startsWith("$$") || line.trim().startsWith("\\[")) {
      const marker = line.trim().startsWith("$$") ? "$$" : "\\]";
      const first = line.trim().slice(2);
      const parts: string[] = [];
      if (first.endsWith(marker)) {
        parts.push(first.slice(0, -2));
        index++;
      } else {
        if (first) parts.push(first);
        index++;
        while (index < lines.length && !lines[index].trim().endsWith(marker))
          parts.push(lines[index++]);
        if (index < lines.length)
          parts.push(lines[index++].trim().slice(0, -2));
      }
      blocks.push(
        `<div class="math-block">${math(parts.join("\n"), true)}</div>`,
      );
      continue;
    }
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w-]*)\s*$/);
    if (fence) {
      const marker = fence[1][0];
      const content: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[index])
      ) {
        content.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const name = fence[2],
        sourceCode = content.join("\n"),
        canonical = aliases[name] ?? name;
      const key = `${canonical}:${sourceCode}`;
      let highlighted = codeCache.get(key);
      if (highlighted === undefined) {
        highlighted =
          options.highlight !== false &&
          sourceCode.length < 40_000 &&
          hljs.getLanguage(canonical)
            ? hljs.highlight(sourceCode, {
                language: canonical,
                ignoreIllegals: true,
              }).value
            : escapeHtml(sourceCode);
        if (options.highlight !== false) {
          codeCache.set(key, highlighted);
          if (codeCache.size > 128)
            codeCache.delete(codeCache.keys().next().value!);
        }
      }
      const language = name ? ` class="language-${escapeHtml(name)}"` : "";
      blocks.push(
        `<div class="code-block"><div class="code-toolbar"><span>${escapeHtml(name || "text")}</span><button type="button" data-code-copy>${options.en ? "Copy code" : "复制代码"}</button></div><pre><code${language}>${highlighted}</code></pre></div>`,
      );
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push(
        `<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`,
      );
      index += 1;
      continue;
    }
    if (/^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      blocks.push("<hr />");
      index += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(
        `<blockquote>${quote.map(renderInline).join("<br />")}</blockquote>`,
      );
      continue;
    }
    if (/^\s*[-+*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list: string[] = [];
      while (
        index < lines.length &&
        (ordered
          ? /^\s*\d+[.)]\s+/.test(lines[index])
          : /^\s*[-+*]\s+/.test(lines[index]))
      ) {
        list.push(lines[index]);
        index += 1;
      }
      blocks.push(renderList(list, ordered));
      continue;
    }
    if (
      index + 1 < lines.length &&
      line.includes("|") &&
      isTableSeparator(lines[index + 1])
    ) {
      const headers = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (
        index < lines.length &&
        lines[index].includes("|") &&
        lines[index].trim()
      ) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push(
        `<table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_cell, cellIndex) => `<td>${renderInline(row[cellIndex] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
      );
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*(```|~~~|>|[-+*]\s+|\d+[.)]\s+)/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(`<p>${paragraph.map(renderInline).join("<br />")}</p>`);
  }
  return blocks.join("\n");
}
