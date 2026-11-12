import http from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { OpenCode } from "@opencode/client";

export async function createOpenCodeV2Fixture(options: { directory?: string; autoRespond?: boolean; password?: string; port?: number } = {}) {
  const directory = options.directory ?? process.cwd();
  const streams = new Set<http.ServerResponse>(), sessions = new Map<string, any>();
  const calls: any[] = [], log: any[] = [];
  const model = { id: "model/with-slash", modelID: "remote-model", providerID: "fixture", name: "Fixture model", type: "chat", enabled: true, status: "active",
    variants: [{ id: "low" }, { id: "high" }], capabilities: { input: ["text", "image"], output: ["text"], tools: true }, limit: { context: 32000, output: 4096 } };
  const mcp = new Map<string, any>();
  let sequence = 0, eventID = 0, sessionID = 0;
  let failPrompt = 0, failInterrupt = 0, defer = false, release = () => {};
  const send = (type: string, data: any, durable = true) => {
    const event = { id: `evt_${++eventID}`, created: Date.now(), type, data, location: { directory }, ...(durable ? { durable: { aggregateID: data.sessionID, seq: ++sequence, version: 1 } } : {}) };
    if (durable) log.push(event);
    for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    return event;
  };
  const assistant = (id: string) => {
    const session = sessions.get(id);
    const message = { id: `msg_a_${++eventID}`, type: "assistant", agent: "build", model: session.model ?? { id: model.id, providerID: "fixture" }, time: { created: Date.now() }, content: [] as any[],
      tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 4, write: 5 } }, cost: 0.01 };
    session.messages.push(message);
    send("session.step.started", { sessionID: id, assistantMessageID: message.id, agent: "build", model: message.model, started: Date.now() });
    return message;
  };
  const content = (id: string, message: any, type: "text" | "reasoning", text: string) => {
    const ordinal = message.content.length;
    message.content.push({ type, text });
    send(`session.${type}.started`, { sessionID: id, assistantMessageID: message.id, ordinal });
    send(`session.${type}.delta`, { sessionID: id, assistantMessageID: message.id, ordinal, delta: text }, false);
    send(`session.${type}.ended`, { sessionID: id, assistantMessageID: message.id, ordinal, text });
    return ordinal;
  };
  const tool = (id: string, message: any, name = "shell", input = { command: "echo fixture" }) => {
    const callID = `tool_${++eventID}`;
    send("session.tool.input.started", { sessionID: id, assistantMessageID: message.id, id: callID, name });
    send("session.tool.called", { sessionID: id, assistantMessageID: message.id, id: callID, input, executed: true });
    const output = [{ type: "text", text: "fixture output" }];
    message.content.push({ type: "tool", id: callID, name, time: { created: 1, completed: 2 }, state: { status: "completed", input, content: output, metadata: {} } });
    send("session.tool.success", { sessionID: id, assistantMessageID: message.id, id: callID, content: output, executed: true });
    return callID;
  };
  const finish = (id: string, message: any, finishReason = "stop") => {
    message.time.completed = Date.now(); message.finish = finishReason;
    send("session.step.ended", { sessionID: id, assistantMessageID: message.id, finish: finishReason, tokens: message.tokens, cost: message.cost });
    sessions.get(id).busy = false;
    const info = sessions.get(id).info;
    info.cost += message.cost;
    for (const key of ["input", "output", "reasoning"]) info.tokens[key] += message.tokens[key];
    for (const key of ["read", "write"]) info.tokens.cache[key] += message.tokens.cache[key];
    send("session.execution.succeeded", { sessionID: id });
  };
  const ask = (id: string, action = "shell", save = ["python *"]) => {
    const request = { id: `per_${++eventID}`, sessionID: id, action, resources: ["python experiment.py"], save, metadata: { command: "python experiment.py" } };
    sessions.get(id).permissions.push(request);
    send("permission.asked", request, false);
    return request;
  };
  const respond = (id: string, text: string) => {
    if (text.includes("approval-check")) { ask(id); return; }
    if (text.includes("hold")) return;
    const message = assistant(id); content(id, message, "reasoning", "Checking fixture context.");
    content(id, message, "text", "I will check."); tool(id, message); content(id, message, "text", "OpenCode 2 verified."); finish(id, message);
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://fixture");
      if (options.password && request.headers.authorization !== `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`) { response.writeHead(401).end(); return; }
      let text = ""; for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : {};
      calls.push({ method: request.method, path: url.pathname, body, query: Object.fromEntries(url.searchParams), headers: request.headers });
      const json = (value: unknown, code = 200) => { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      const empty = () => { response.writeHead(204).end(); };
      if (url.pathname === "/api/info") return json({ version: "2.2.7", pid: process.pid, paths: { tmp: directory }, urls: [] });
      if (url.pathname === "/api/event") {
        response.writeHead(200, { "content-type": "text/event-stream" }); streams.add(response);
        response.write(`data: ${JSON.stringify({ id: `connected_${++eventID}`, type: "server.connected", data: {} })}\n\n`);
        response.on("close", () => streams.delete(response)); return;
      }
      if (url.pathname === "/api/model") return json({ location: { directory }, data: [model, { ...model, id: "image", type: "image" }, { ...model, id: "disabled", enabled: false }] });
      if (url.pathname === "/api/model/default") return json({ location: { directory }, data: model });
      if (url.pathname === "/api/provider") return json({ location: { directory }, data: [{ id: "fixture", name: "Fixture provider", settings: { apiKey: "fixture-secret" } }] });
      const mcpMatch = url.pathname.match(/^\/api\/experimental\/mcp\/([^/]+)(\/connect)?$/);
      if (mcpMatch) { mcp.set(mcpMatch[1], { name: mcpMatch[1], status: { status: "connected" }, config: body.config }); return empty(); }
      if (url.pathname === "/api/mcp") return json({ location: { directory }, data: [...mcp.values()] });
      if (url.pathname === "/api/session/active") return json({ data: Object.fromEntries([...sessions].filter(([, value]) => value.busy).map(([id]) => [id, { type: "running" }])) });
      if (url.pathname === "/api/session" && request.method === "POST") {
        const id = `ses_fixture_${++sessionID}`;
        const info = { id, projectID: "fixture-project", location: body.location ?? { directory }, permissions: body.permissions ?? [], title: body.title, model: body.model,
          cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now(), updated: Date.now() } };
        sessions.set(id, { info, messages: [], permissions: [], busy: false, instructions: {} });
        return json({ data: info });
      }
      const history = url.pathname.match(/^\/api\/experimental\/session\/([^/]+)\/log$/);
      if (history) { response.writeHead(200, { "content-type": "text/event-stream" }); for (const event of log) if (event.data.sessionID === history[1] && event.durable.seq > Number(url.searchParams.get("after") ?? 0)) response.write(`data: ${JSON.stringify(event)}\n\n`); response.end(); return; }
      const instructions = url.pathname.match(/^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/([^/]+)$/);
      if (instructions) { const session = sessions.get(instructions[1]); if (request.method === "PUT") session.instructions[instructions[2]] = body.value; else delete session.instructions[instructions[2]]; return empty(); }
      const match = url.pathname.match(/^\/api\/session\/([^/]+)(.*)$/), session = match ? sessions.get(match[1]) : undefined;
      if (!match || !session) return json({ _tag: "SessionNotFoundError", message: "Session missing" }, 404);
      const id = match[1], tail = match[2];
      if (!tail && request.method === "GET") return json({ data: session.info });
      if (!tail && request.method === "PATCH") { Object.assign(session.info, body); return empty(); }
      if (tail === "/model") { session.model = body.model; return empty(); }
      if (/^\/inbox\/[^/]+$/.test(tail) && request.method === "DELETE") return empty();
      if (tail === "/prompt") {
        if (failPrompt) return json({ _tag: "ConflictError", message: "fixture prompt failed" }, failPrompt);
        if (session.messages.some((value: any) => value.id === body.id)) return json({ data: { id: body.id } });
        session.messages.push({ id: body.id, type: "user", text: body.text, metadata: body.metadata, files: body.files, time: { created: Date.now() } }); session.busy = true;
        send("session.inbox.delivered", { sessionID: id, inboxID: body.id }); send("session.execution.started", { sessionID: id });
        const admit = () => { json({ data: { id: body.id, sessionID: id, type: "user", delivery: body.delivery, payload: body, time: { created: Date.now() } } }); if (options.autoRespond) setTimeout(() => respond(id, body.text), 30); };
        if (defer) release = admit; else admit(); return;
      }
      if (tail === "/message") {
        if (url.searchParams.has("cursor") && url.searchParams.has("order")) return json({ _tag: "InvalidCursorError", message: "Cursor cannot be combined with order" }, 400);
        const start = Number(url.searchParams.get("cursor") ?? 0), limit = Number(url.searchParams.get("limit") ?? 100);
        const data = session.messages.slice(start, start + limit);
        return json({ data, cursor: { next: data.length ? String(start + data.length) : undefined } });
      }
      if (tail === "/interrupt") {
        if (failInterrupt) return json({ message: "interrupt failed" }, failInterrupt);
        const interrupted = session.busy; session.busy = false; session.permissions = [];
        send("session.execution.interrupted", { sessionID: id, reason: "user" }); return json({ interrupted });
      }
      if (tail === "/permission") return json({ data: session.permissions });
      const permission = tail.match(/^\/permission\/([^/]+)\/reply$/);
      if (permission) {
        const pending = session.permissions.find((value: any) => value.id === permission[1]);
        session.permissions = body.decision === "reject" ? [] : session.permissions.filter((value: any) => value !== pending);
        send("permission.replied", { sessionID: id, requestID: permission[1], reply: body.decision }, false); empty();
        if (options.autoRespond) setTimeout(() => { const message = assistant(id); content(id, message, "text", `Native reply: ${body.decision}`); finish(id, message); }, 20);
        return;
      }
      json({ message: `Unknown fixture endpoint ${url.pathname}` }, 404);
    } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ message: String(error) })); }
  });
  server.listen(options.port ?? 0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = OpenCode.make({ baseUrl: url, ...(options.password ? { headers: { authorization: `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}` } } : {}) });
  return { url, client, calls, sessions, streams, log, model, send, assistant, content, tool, finish, ask,
    disconnect: () => { for (const stream of streams) stream.end(); streams.clear(); },
    deferPrompt: () => { defer = true; }, releasePrompt: () => release(),
    failPrompt: (status: number) => { failPrompt = status; }, failInterrupt: (status: number) => { failInterrupt = status; },
    close: async () => { for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--version")) console.log("2.2.7");
  else {
    const fixture = await createOpenCodeV2Fixture({ autoRespond: true, password: process.env.OPENCODE_PASSWORD,
      port: Number(process.argv.find(arg => arg.startsWith("--port="))?.slice(7) ?? 0) });
    console.log(fixture.url);
  }
}
