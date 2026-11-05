import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
// Usage: npm run build:frontend && node scripts/diagnostics/benchmark-agent-ui.mjs after
// The temporary localhost server serves deterministic API fixtures. It never
// starts a model or accesses an existing research session.
const label = process.argv[2] ?? "current";
if (!/^[a-z0-9-]+$/.test(label))
  throw new Error("Use a lowercase report label.");
await mkdir("runtime/agent-improvements", { recursive: true });
await readFile("frontend/dist/index.html");
const runs = [],
  clients = new Set();
let session,
  sequence = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture");
  const json = (x) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(x));
  };
  if (url.pathname.endsWith("/events")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/api/auth/status") return json({ initialized: true });
  if (url.pathname === "/api/auth/me")
    return json({ user: { id: "benchmark", displayName: "Benchmark" } });
  if (url.pathname === "/api/collaboration/context")
    return json({
      actor: { id: "benchmark" },
      project: { id: "benchmark", name: "Benchmark" },
      permissions: ["*"],
    });
  if (url.pathname === "/api/agent-profiles")
    return json({
      profiles: [
        {
          id: "fixture",
          provider: "fixture",
          label: "Benchmark Agent",
          availability: "ready",
          model: "gpt-6-luna",
          models: [{ id: "gpt-6-luna", label: "Luna" }],
        },
      ],
    });
  if (url.pathname === "/api/agent-sessions")
    return json({
      sessions: [
        { ...session, events: undefined, conversationEvents: undefined },
      ],
    });
  if (url.pathname === "/api/research/context")
    return json({
      candidates: [],
      reads: [],
      sources: [],
      topology: { nodes: [], edges: [] },
    });
  if (url.pathname.startsWith("/api/")) return json(session);
  try {
    const file = path.resolve(
      "frontend/dist",
      url.pathname === "/" ? "index.html" : url.pathname.slice(1),
    );
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch();
try {
  for (const count of [100, 500, 1000]) {
    sequence = 0;
    const events = [];
    const add = (type, payload, turnId) =>
      events.push({
        id: `e${++sequence}`,
        cursor: sequence,
        sessionId: "bench",
        turnId,
        type,
        payload,
        occurredAt: "2026-10-29T10:00:00Z",
      });
    for (let i = 0; i < count; i++) {
      add(
        "user.message",
        { text: `Question ${i}: inspect scientific evidence` },
        `t${i}`,
      );
      add(
        "assistant.message.completed",
        {
          blockId: `a${i}`,
          text: `Evidence ${i}\n\n${"A reproducible result with versioned evidence. ".repeat(12)}\n\n\`\`\`python\nprint('result')\n\`\`\``,
        },
        `t${i}`,
      );
    }
    add(
      "assistant.message.snapshot",
      { blockId: "stream", text: "BENCH0", completion: "streaming" },
      "live",
    );
    session = {
      id: "bench",
      title: "Agent performance benchmark",
      profileId: "fixture",
      provider: "fixture",
      status: "running",
      activeTurnId: "live",
      lastCursor: sequence,
      createdAt: "2026-10-29T10:00:00Z",
      updatedAt: "2026-10-29T10:00:00Z",
      events,
      conversationEvents: events,
      queuedMessages: [],
      pendingApprovals: [],
    };
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    await page.addInitScript(() => {
      localStorage.setItem("research-workbench-project", "benchmark");
      window.__bench = { start: {}, samples: [], seen: new Set(), frames: [] };
      const Native = window.EventSource;
      window.EventSource = class extends Native {
        constructor(...args) {
          super(...args);
          this.addEventListener("session", (e) => {
            const p = JSON.parse(e.data);
            const n = /BENCH(\d+)/.exec(p.payload?.delta ?? "");
            if (n) window.__bench.start[n[1]] = performance.now();
          });
        }
      };
      let prev = performance.now();
      const frame = (now) => {
        window.__bench.frames.push(now - prev);
        prev = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      new MutationObserver(() => {
        const nodes = document.querySelectorAll(".message-body");
        const value = nodes[nodes.length - 1]?.textContent ?? "";
        const matches = [...value.matchAll(/BENCH(\d+)/g)];
        const n = matches.at(-1)?.[1];
        if (n && window.__bench.start[n] && !window.__bench.seen.has(n)) {
          window.__bench.seen.add(n);
          requestAnimationFrame(() =>
            window.__bench.samples.push(
              performance.now() - window.__bench.start[n],
            ),
          );
        }
      }).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    const start = Date.now();
    await page.goto(`http://127.0.0.1:${server.address().port}/#/agents`);
    await page
      .locator(".message-body")
      .last()
      .filter({ hasText: "BENCH0" })
      .waitFor({ timeout: 60000 });
    const initialMs = Date.now() - start;
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      window.__bench.frames = [];
    });
    for (let n = 1; n <= 50; n++) {
      const event = {
        id: `e${++sequence}`,
        cursor: sequence,
        sessionId: "bench",
        turnId: "live",
        type: "assistant.message.delta",
        payload: { blockId: "stream", delta: ` BENCH${n}` },
        occurredAt: new Date().toISOString(),
      };
      for (const c of clients)
        c.write(`event: session\ndata: ${JSON.stringify(event)}\n\n`);
      await new Promise((r) => setTimeout(r, 30));
    }
    await page.waitForTimeout(500);
    const result = await page.evaluate(() => {
      const stats = (a) => {
        a = a.filter(Number.isFinite).sort((x, y) => x - y);
        return {
          p50: a[Math.floor(a.length * 0.5)] ?? 0,
          p95: a[Math.floor(a.length * 0.95)] ?? 0,
          max: a.at(-1) ?? 0,
        };
      };
      return {
        renderLatencyMs: stats(window.__bench.samples),
        paintedUpdates: window.__bench.samples.length,
        frameGapMs: stats(window.__bench.frames),
        domNodes: document.querySelectorAll("*").length,
        messageCount: document.querySelectorAll(".message").length,
        codeBlocks: document.querySelectorAll(".code-block").length,
        mathNodes: document.querySelectorAll(".katex").length,
        geometry: [
          ...document.querySelectorAll(
            ".agent-workspace-main,.agent-workbench,.agent-grid,.conversation,.conversation-body,.composer,.conversation-scroll",
          ),
        ].map((n) => ({
          class: n.className,
          h: n.getBoundingClientRect().height,
          display: getComputedStyle(n).display,
        })),
        heapBytes: performance.memory?.usedJSHeapSize,
        bodyHeight: document.querySelector(".conversation-scroll")
          ?.clientHeight,
      };
    });
    if (result.messageCount !== count * 2 + 1)
      throw new Error("Duplicate or missing conversation rows");
    if ((await page.locator(".conversation-body").count()) !== 1)
      throw new Error("Duplicate transcript");
    await page
      .locator(".message-body")
      .last()
      .filter({ hasText: "BENCH50" })
      .waitFor({ timeout: 10000 });
    runs.push({
      messagePairs: count,
      eventIntervalMs: 30,
      eventsSent: 50,
      initialMs,
      ...result,
    });
    await page.close();
  }
} finally {
  await browser.close();
  for (const c of clients) c.end();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
await writeFile(
  `runtime/agent-improvements/performance-${label}.json`,
  JSON.stringify({ generatedAt: new Date().toISOString(), runs }, null, 2),
);
console.log(JSON.stringify(runs));
