import http from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

export const model = "gpt-6-luna";

// Observe the wire model and provider accounting without retaining prompts, headers or credentials.
export async function meteredGateway(upstream, key) {
  const secret = randomUUID();
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const api = path.split("/").filter(Boolean).slice(-2).join("/");
    const kind = path.endsWith("/responses") ? "responses" : path.endsWith("/messages") ? "messages" : path.endsWith("/chat/completions") ? "chat" : null;
    if (!kind || req.method !== "POST" || ![req.headers["x-api-key"], req.headers.authorization?.replace(/^Bearer /i, "")].includes(secret)) {
      res.writeHead(403).end();
      return;
    }
    const entry = { api, requested: null, returned: null, status: null, usage: null };
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const parsed = JSON.parse(body);
      entry.requested = parsed.model;
      const transfer = parsed.tools?.find(t => (t.name ?? t.function?.name ?? "").endsWith("transfer_asset"));
      if (transfer && !requests.some(r => r.transferSchema)) {
        const shape = transfer.input_schema ?? transfer.parameters ?? transfer.function?.parameters ?? {};
        entry.transferSchema = { keys: Object.keys(shape), fields: Object.keys(shape.properties ?? {}) };
      }
      requests.push(entry);
      if (parsed.model !== model) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Evaluation requires " + model } }));
        entry.status = 400;
        return;
      }
      const headers = { "content-type": "application/json", authorization: "Bearer " + key };
      if (kind === "messages") {
        headers["x-api-key"] = key;
        headers["anthropic-version"] = req.headers["anthropic-version"] || "2023-06-01";
        if (req.headers["anthropic-beta"]) headers["anthropic-beta"] = req.headers["anthropic-beta"];
      }
      const url = new URL(upstream);
      const route = kind === "chat" ? "chat/completions" : kind;
      url.pathname = url.pathname.replace(/\/$/, "") + "/" + route;
      const response = await fetch(url, { method: "POST", headers, body, signal: abort.signal, redirect: "error" });
      entry.status = response.status;
      const contentType = response.headers.get("content-type") || "application/json";
      res.writeHead(response.status, { "content-type": contentType });
      const decoder = new TextDecoder();
      let buffer = "";
      function observe(line) {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        const message = event.response ?? event.message ?? event;
        if (typeof message.model === "string") entry.returned = message.model;
        if (message.usage) entry.usage = { ...entry.usage, ...message.usage };
        if (event.error) entry.error = String(event.error.message ?? event.error.type ?? "").slice(0, 350);
      }
      for await (const part of response.body) {
        res.write(part);
        buffer += decoder.decode(part, { stream: true });
        if (contentType.includes("event-stream")) {
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end).trimEnd();
            buffer = buffer.slice(end + 1);
            if (line.startsWith("data:")) observe(line.slice(5).trim());
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) observe(buffer.trim().replace(/^data:\s*/, ""));
      res.end();
    } catch (error) {
      entry.error = error.cause?.code ?? error.message;
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: "http://127.0.0.1:" + server.address().port, secret, requests, close: () => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  } };
}

export function providerTokens(requests) {
  const rows = requests.filter(row => row.status === 200);
  if (!rows.length || rows.some(row => !row.usage)) return null;
  let input = 0, output = 0, cached = 0;
  for (const { api, usage } of rows) {
    const anthropic = api.endsWith("messages");
    const read = usage.cache_read_input_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const prompt = usage.input_tokens ?? usage.prompt_tokens;
    const completion = usage.output_tokens ?? usage.completion_tokens;
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
    input += prompt + (anthropic ? read + (usage.cache_creation_input_tokens ?? 0) : 0);
    output += completion;
    cached += read;
  }
  return { input, cached, output, total: input + output };
}
