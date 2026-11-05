import readline from "node:readline";
import { openResearchMcp } from "../../src/mcp/research-probe.js";

let threadId = "fixture-codex-thread";
let turnNumber = 0;
let pendingApproval = null;
let researchBinding = null;
let developerInstructionsConfigured = false;
let inlineReviews = false;
const reviewHistory = new Map();

function send(message) {
  if (inlineReviews && message.method === "item/completed") {
    const { turnId, item } = message.params;
    if (!reviewHistory.has(turnId)) reviewHistory.set(turnId, []);
    reviewHistory.get(turnId).push(item);
  }
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function completeTurn(status = "completed") {
  send({
    method: "turn/completed",
    params: { threadId, turn: { id: `fixture-codex-turn-${turnNumber}`, status } },
  });
}

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on("line", async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (pendingApproval && message.id === pendingApproval.id) {
    pendingApproval = null;
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: `fixture-codex-turn-${turnNumber}`, itemId: "fixture-agent-message", delta: process.env.CODEX_FIXTURE_APPROVAL_KIND ? JSON.stringify(message.result) : "审批已处理。" } });
    send({ method: "item/completed", params: { threadId, turnId: `fixture-codex-turn-${turnNumber}`, completedAtMs: Date.now(), item: { id: "fixture-command", type: "commandExecution", command: "python evaluate.py", commandActions: [], cwd: "E:/ResearchWorkspace", status: "completed", aggregatedOutput: "ok" } } });
    completeTurn(message.result?.decision === "cancel" ? "interrupted" : "completed");
    return;
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fixture-codex/0.1.0", platformFamily: "windows", platformOs: "windows" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    researchBinding = message.params?.config?.mcp_servers?.topolumia ?? null;
    developerInstructionsConfigured = typeof message.params?.developerInstructions === "string" && message.params.developerInstructions.includes("Topolumia");
    send({ id: message.id, result: { thread: { id: threadId, sessionId: threadId }, model: "gpt-5.6-luna", approvalPolicy: "never", sandbox: { type: "readOnly" } } });
    send({ method: "thread/started", params: { thread: { id: threadId, sessionId: threadId } } });
    return;
  }
  if (message.method === "thread/read") {
    send({ id: message.id, result: { thread: { id: threadId, ephemeral: false, historyMode: "paginated", cwd: "E:/ResearchWorkspace", updatedAt: Date.now() } } });
    return;
  }
  if (message.method === "thread/resume") {
    researchBinding = message.params?.config?.mcp_servers?.topolumia ?? null;
    developerInstructionsConfigured = typeof message.params?.developerInstructions === "string" && message.params.developerInstructions.includes("Topolumia");
    send({ id: message.id, result: { thread: { id: threadId, ephemeral: false, historyMode: "paginated" } } });
    return;
  }
  if (message.method === "thread/turns/list") {
    if (inlineReviews) { send({ id: message.id, result: { data: [...reviewHistory].map(([id, items]) => ({ id, items, status: "completed" })) } }); return; }
    send({ id: message.id, result: { data: [{ id: `fixture-codex-turn-${turnNumber}`, rootTurnId: `fixture-codex-turn-${turnNumber}`, items: [{ type: "commandExecution", id: "fixture-command", command: "python evaluate.py", cwd: "E:/ResearchWorkspace", status: "completed", aggregatedOutput: "PSNR=31.4" }] }] } });
    return;
  }
  if (message.method === "thread/items/list") {
    if (inlineReviews) { send({ id: message.id, result: { data: [] } }); return; }
    send({ id: message.id, result: { data: [{ turnId: `fixture-codex-turn-${turnNumber}`, item: { type: "commandExecution", id: "fixture-command", command: "python evaluate.py", cwd: "E:/ResearchWorkspace", status: "completed", aggregatedOutput: "PSNR=31.4" } }] } });
    return;
  }
  if (message.method === "turn/start") {
    turnNumber += 1;
    const turnId = `fixture-codex-turn-${turnNumber}`;
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    const text = message.params?.input?.[0]?.text ?? "";
    if (text.includes("inline-review")) {
      inlineReviews = true;
      let connection;
      try {
        connection = await openResearchMcp(researchBinding);
        const tool = async (name, args, key) => {
          const item = { id: `review-${turnNumber}-${key}`, type: "mcpToolCall", server: "topolumia", tool: name, arguments: args, status: "inProgress" };
          send({ method: "item/started", params: { threadId, turnId, item } });
          const result = await connection.client.callTool({ name, arguments: args });
          if (result.isError) throw new Error(JSON.stringify(result));
          send({ method: "item/completed", params: { threadId, turnId, item: { ...item, status: "completed", result } } });
          return result.structuredContent.data;
        };
        const primary = await tool("create_candidate", { reason: `论文阅读结果 ${turnNumber}`, nodes: [{ kind: "paper", core: { nodeName: `Reviewed paper ${turnNumber}`, paperTitle: "Source-grounded research review" }, blocks: [{ title: "方法与证据", type: "richText", payload: { format: "markdown", body: "The method and evidence are preserved for review." } }] }] }, "create");
        await tool("edit_candidate", { candidateId: primary.candidateId, expectedRevision: primary.revision, nodeChanges: [{ nodeId: primary.nodes[0].nodeId, addBlocks: [{ title: "局限", type: "richText", payload: { format: "markdown", body: "These findings require independent validation." } }] }] }, "edit");
        if (turnNumber === 1) await tool("create_candidate", { reason: "后续研究问题", nodes: [{ kind: "question", core: { nodeName: "How robust is this result?" } }] }, "question");
        send({ method: "item/completed", params: { threadId, turnId, item: { id: `review-progress-${turnNumber}`, type: "agentMessage", phase: "commentary", text: "候选已提出，正在完成结果说明。" } } });
        await new Promise(resolve => setTimeout(resolve, 1500));
        send({ method: "item/completed", params: { threadId, turnId, item: { id: `review-answer-${turnNumber}`, type: "agentMessage", phase: "final_answer", text: `本轮 ${turnNumber} 的科研候选已准备好，请审阅。` } } });
        completeTurn();
      } catch (error) {
        send({ method: "error", params: { threadId, turnId, error: { message: error.message } } });
      } finally { await connection?.close(); }
      return;
    }
    if (text.includes("mcp-bind")) {
      try {
        const connection = await openResearchMcp(researchBinding);
        let result;
        try { result = await connection.client.callTool({ name: "get_context", arguments: {} }); } finally { await connection.close(); }
        if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
        const context = result.structuredContent;
        const answer = `MCP_PROJECT=${context.projectId}; INTERFACE=${context.schemaVersion}; CLI_PID=${result._meta.execution.pid}`;
        send({ method: "item/completed", params: { threadId, turnId, item: { id: "mcp-context", type: "mcpToolCall", server: "topolumia", tool: "get_context", arguments: {}, result, status: "completed" } } });
        send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "cli-binding", delta: answer } });
        send({ method: "item/completed", params: { threadId, turnId, item: { id: "cli-binding", type: "agentMessage", text: answer } } });
        completeTurn();
      } catch (error) { send({ method: "error", params: { message: `MCP fixture failed: ${error.message}` } }); completeTurn("failed"); }
      return;
    }
    send({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, itemId: "fixture-reasoning", summaryIndex: 0, delta: "先核对实验来源，再执行只读命令。" } });
    if (text.includes("reasoning-blocks")) {
      send({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, itemId: "fixture-reasoning", summaryIndex: 1, delta: "Second paragraph" } });
      send({ method: "item/completed", params: { threadId, turnId, item: { id: "fixture-reasoning", type: "reasoning", summary: ["先核对实验来源，再执行只读命令。", "Second paragraph repaired"] } } });
    }
    send({ method: "item/plan/delta", params: { threadId, turnId, itemId: "fixture-plan", delta: "1. 读取研究状态\n2. 运行只读评估\n3. 汇总输出" } });
    send({ method: "item/started", params: { threadId, turnId, startedAtMs: Date.now(), item: { id: "fixture-command", type: "commandExecution", command: "python evaluate.py", commandActions: [], cwd: "E:/ResearchWorkspace", status: "inProgress" } } });
    if (text.includes("approve")) {
      pendingApproval = { id: 77 };
      const kind = process.env.CODEX_FIXTURE_APPROVAL_KIND;
      const permission = kind === "permissions";
      send({ id: 77, method: permission ? "item/permissions/requestApproval" : "item/commandExecution/requestApproval", params: { itemId: "fixture-command", threadId, turnId, startedAtMs: Date.now(), command: "python evaluate.py", reason: "fixture approval",
        ...(permission ? { permissions: { network: { enabled: true }, fileSystem: { write: ["E:/ResearchOutput"] } } } : {}),
        ...(kind === "restricted" ? { availableDecisions: ["decline", "cancel"] } : {}) } });
      if (kind === "withdraw") setTimeout(() => {
        pendingApproval = null; send({ method: "serverRequest/resolved", params: { threadId, requestId: 77 } }); completeTurn();
      }, 100);
      return;
    }
    send({ method: "item/commandExecution/outputDelta", params: { threadId, turnId, itemId: "fixture-command", delta: "PSNR=31.4\n" } });
    const bindingState = `MCP=${researchBinding ? "ready" : "missing"}; shellCredentials=${process.env.TOPOLUMIA_SESSION ? "present" : "absent"}; guidance=${developerInstructionsConfigured ? "ready" : "missing"}`;
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "fixture-agent-message", delta: `已检查当前实验。${bindingState}` } });
    send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { id: "fixture-agent-message", type: "agentMessage", text: `已检查当前实验。${bindingState}` } } });
    send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { id: "fixture-command", type: "commandExecution", command: "python evaluate.py", commandActions: [], cwd: "E:/ResearchWorkspace", status: "completed", aggregatedOutput: "PSNR=31.4" } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, inputTokens: 420, outputTokens: 96, totalTokens: 516 } });
    completeTurn();
    return;
  }
  if (message.method === "turn/interrupt") {
    if (process.env.CODEX_FIXTURE_INTERRUPT_FAIL === "1") { send({ id: message.id, error: { code: -32000, message: "Fixture interrupt failure" } }); return; }
    if (message.params.turnId !== `fixture-codex-turn-${turnNumber}`) {
      send({ id: message.id, error: { code: -32000, message: "Native turn id required" } });
      return;
    }
    send({ id: message.id, result: {} });
    completeTurn("interrupted");
  }
});

