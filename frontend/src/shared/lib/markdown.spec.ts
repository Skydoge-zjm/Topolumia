import { describe, expect, it } from "vitest";
import { renderMarkdown, renderReasoningSummary } from "./markdown";

describe("frontend markdown adapter", () => {
  it("separates adjacent native reasoning headings without changing inline emphasis elsewhere", () => {
    const html = renderReasoningSummary(
      "**First phase****Second phase**\n\nA **bold** word.",
    );
    const node = document.createElement("div");
    node.innerHTML = html;
    expect(node.querySelectorAll("br")).toHaveLength(1);
    expect([...node.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      "First phaseSecond phase",
      "A bold word.",
    ]);
    expect(node.querySelector("p:last-child")?.innerHTML).toBe(
      "A <strong>bold</strong> word.",
    );
  });
  it("escapes raw HTML while preserving safe inline formatting", () => {
    const html = renderMarkdown("**结果** `ok` <script>alert(1)</script>");
    expect(html).toContain("<strong>结果</strong>");
    expect(html).toContain("<code>ok</code>");
    expect(html).not.toContain("<script>");
  });

  it("renders common block Markdown structures", () => {
    const html = renderMarkdown(
      "# 标题\n\n- 第一项\n- 第二项\n\n> 引用\n\n| 名称 | 状态 |\n| --- | --- |\n| Agent | ready |\n\n```ts\nconst ok = true;\n```",
    );
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain('<pre><code class="language-ts">');
  });

  it("keeps unsafe links as text", () => {
    const html = renderMarkdown(
      "[bad](javascript:alert(1)) [good](https://example.com)",
    );
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
  });

  it("renders scientific math and code highlights without trusting HTML or arbitrary file links", () => {
    const html = renderMarkdown(
      "Inline $x^2 + y^2$\n\n$$\\frac{1}{n}\\sum_i x_i$$\n\n```python\nprint('evidence')\n```\n\n[Source](file:protocol.md) [raw](file:///etc/passwd) <img src=x onerror=alert(1)>",
    );
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(root.querySelectorAll(".katex")).toHaveLength(2);
    expect(root.querySelector(".hljs-string")).toHaveTextContent("evidence");
    expect(root.querySelector("[data-code-copy]")).toHaveTextContent(
      "复制代码",
    );
    expect(root.querySelector("[data-source-ref]")).toHaveAttribute(
      "data-source-ref",
      "file:protocol.md",
    );
    expect(root.querySelector('a[href^="file:"]')).toBeNull();
    expect(root.querySelector("img")).toBeNull();
  });
});
