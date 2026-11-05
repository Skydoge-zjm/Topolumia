import readline from "node:readline";
import { randomUUID } from "node:crypto";

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const sessions = new Map();
const pendingClientRequests = new Map();
let serverRequestId = 10_000;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function update(sessionId, payload) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: payload } });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textOf(prompt) {
  return (prompt ?? []).filter((item) => item?.type === "text").at(-1)?.text ?? "";
}

function requestPermission(sessionId, toolCallId) {
  const id = ++serverRequestId;
  send({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { toolCallId, title: "运行只读指标检查", kind: "execute", status: "pending" },
      options: [
        { optionId: "allow-once", name: "仅本次允许", kind: "allow_once" },
        { optionId: "reject-once", name: "拒绝", kind: "reject_once" },
      ],
    },
  });
  return new Promise((resolve) => pendingClientRequests.set(id, resolve));
}

async function handlePrompt(message) {
  const { id, params } = message;
  const session = sessions.get(params?.sessionId);
  if (!session) {
    fail(id, -32001, "Unknown session");
    return;
  }
  session.cancelled = false;
  const prompt = textOf(params.prompt);
  const slow = /慢速|slow/i.test(prompt);
  const needsApproval = /审批|运行|execute|command/i.test(prompt);
  const pause = Number(process.env.RESEARCH_FIXTURE_PAUSE_MS) || (slow ? 180 : 28);

  update(session.id, {
    sessionUpdate: "plan",
    entries: [
      { content: "核对 Working Set 中的 G0/G1 运行与协议条件", priority: "high", status: "in_progress" },
      { content: "区分直接观测与条件归因", priority: "high", status: "pending" },
      { content: "给出下一步区分实验", priority: "medium", status: "pending" },
    ],
  });
  await sleep(pause);
  if (session.cancelled) return respond(id, { stopReason: "cancelled" });

  update(session.id, {
    sessionUpdate: "agent_message_chunk",
    messageId: `msg_${randomUUID()}`,
    content: { type: "text", text: "我先沿当前 Working Set 核对 G0 与 G1，" },
  });
  const readToolId = `tool_read_${randomUUID()}`;
  update(session.id, {
    sessionUpdate: "tool_call",
    toolCallId: readToolId,
    title: "读取扩散超分实验计划与 G1 指标",
    kind: "read",
    status: "pending",
    locations: [
      { path: "mvp/fixtures/research/experiment-plan.md", line: 1 },
      { path: "mvp/fixtures/mlflow-runs.json", line: 1 },
    ],
    rawInput: { refs: ["file:experiment-plan.md", "mlflow:run:sr3-g1-s42"] },
  });
  update(session.id, {
    sessionUpdate: "tool_call_update",
    toolCallId: readToolId,
    status: "in_progress",
    content: [{ type: "content", content: { type: "text", text: "正在比较 LPIPS、PSNR 与 evaluator 条件…" } }],
  });
  await sleep(pause);
  if (session.cancelled) return respond(id, { stopReason: "cancelled" });
  update(session.id, {
    sessionUpdate: "tool_call_update",
    toolCallId: readToolId,
    status: "completed",
    content: [{
      type: "content",
      content: {
        type: "text",
        text: "G1 的 LPIPS 低于 G0，但当前只有单 seed；checkpoint、采样步数和 evaluator 版本需要保持一致后才能归因。",
      },
    }],
    rawOutput: { observedGroups: ["G0", "G1"], missing: ["multi-seed", "factorial control"] },
  });

  if (needsApproval) {
    const commandToolId = `tool_exec_${randomUUID()}`;
    update(session.id, {
      sessionUpdate: "tool_call",
      toolCallId: commandToolId,
      title: "运行只读指标一致性检查",
      kind: "execute",
      status: "pending",
      rawInput: { command: "python scripts/compare_metrics.py --groups G0 G1 --read-only" },
    });
    const permission = await requestPermission(session.id, commandToolId);
    const selected = permission?.outcome?.optionId;
    if (session.cancelled || permission?.outcome?.outcome === "cancelled") return respond(id, { stopReason: "cancelled" });
    if (selected !== "allow-once") {
      update(session.id, {
        sessionUpdate: "tool_call_update",
        toolCallId: commandToolId,
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "用户拒绝运行；未执行命令。" } }],
      });
    } else {
      update(session.id, {
        sessionUpdate: "tool_call_update",
        toolCallId: commandToolId,
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "检查三个 run 的 evaluator 与采样配置…" } }],
      });
      await sleep(pause);
      update(session.id, {
        sessionUpdate: "tool_call_update",
        toolCallId: commandToolId,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "检查完成：G0/G1 evaluator 一致；仍缺少 3-seed 重复。" } }],
      });
    }
  }

  await sleep(pause);
  if (session.cancelled) return respond(id, { stopReason: "cancelled" });
  update(session.id, {
    sessionUpdate: "agent_message_chunk",
    messageId: `msg_${randomUUID()}`,
    content: {
      type: "text",
      text: "现阶段只能记录‘G1 在当前 run 上观察到感知指标改善’，不能接受‘退化感知条件产生主效应’。下一步应做 2×2 因子实验，并对每个 cell 跑 3 个 seed。",
    },
  });
  update(session.id, {
    sessionUpdate: "plan",
    entries: [
      { content: "核对 Working Set 中的 G0/G1 运行与协议条件", priority: "high", status: "completed" },
      { content: "区分直接观测与条件归因", priority: "high", status: "completed" },
      { content: "给出下一步区分实验", priority: "medium", status: "completed" },
    ],
  });
  update(session.id, { sessionUpdate: "usage_update", used: 18_420, size: 200_000, cost: { amount: 0.012, currency: "USD" } });
  respond(id, { stopReason: "end_turn" });
}

reader.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message.method && message.id !== undefined) {
    const pending = pendingClientRequests.get(message.id);
    if (pending) {
      pendingClientRequests.delete(message.id);
      pending(message.result);
    }
    return;
  }
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        sessionCapabilities: { resume: {}, close: {} },
      },
      agentInfo: { name: "research-fixture-acp", title: "Research Demo ACP Agent", version: "0.1.0" },
      authMethods: [],
    });
    return;
  }
  if (message.method === "session/new") {
    const sessionId = `fixture_${randomUUID()}`;
    sessions.set(sessionId, { id: sessionId, cwd: message.params?.cwd, cancelled: false });
    respond(message.id, { sessionId });
    return;
  }
  if (message.method === "session/load" || message.method === "session/resume") {
    if (!sessions.has(message.params?.sessionId)) sessions.set(message.params.sessionId, { id: message.params.sessionId, cancelled: false });
    respond(message.id, {});
    return;
  }
  if (message.method === "session/prompt") {
    void handlePrompt(message);
    return;
  }
  if (message.method === "session/cancel") {
    const session = sessions.get(message.params?.sessionId);
    if (session) session.cancelled = true;
    for (const [id, resolve] of pendingClientRequests) {
      pendingClientRequests.delete(id);
      resolve({ outcome: { outcome: "cancelled" } });
    }
    return;
  }
  if (message.method === "session/close") {
    sessions.delete(message.params?.sessionId);
    respond(message.id, {});
    return;
  }
  if (message.id !== undefined) fail(message.id, -32601, `Method not found: ${message.method}`);
});
