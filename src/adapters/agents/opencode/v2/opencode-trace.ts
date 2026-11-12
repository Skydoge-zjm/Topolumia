import type { OpenCodeV2Event } from "./opencode-event-stream.js";
import type { SessionMessageInfo, SessionMessageAssistant, SessionInfo, TokenUsageInfo, ToolContent } from "@opencode/client";
import type { DriverEvent } from "../../../../domain/agents/agent-types.js";

type ToolState = { name: string; input: Record<string, unknown>; started: boolean; final?: string };
type TextState = { text: string; completed: boolean; kind: "text" | "reasoning" };

export class OpenCodeV2Trace {
  private text = new Map<string, TextState>();
  private tools = new Map<string, ToolState>();
  private usage = new Map<string, string>();
  private turnId: string | null = null;
  private parentID?: string;
  private eventID?: string;

  constructor(private emit: (event: DriverEvent) => void) {}

  private send(type: string, messageID: string, itemID: string, payload: Record<string, unknown>): void {
    this.emit({ type, turnId: this.turnId, payload: { nativeMessageId: messageID, nativeItemId: itemID,
      nativeParentId: this.parentID, nativeEventId: this.eventID, ...payload } });
  }

  private content(messageID: string, ordinal: number, kind: "text" | "reasoning", value: string, completed: boolean, incomplete = false): void {
    const id = `${messageID}:${kind}:${ordinal}`;
    const previous = this.text.get(id);
    if (previous?.completed && !completed) return;
    if (previous?.text === value && previous.completed === completed) return;
    const prefix = kind === "text" ? "assistant.message" : "reasoning.summary";
    if (completed) this.send(`${prefix}.completed`, messageID, id, { messageId: id, blockId: id, text: value, updateKind: "snapshot", completion: incomplete ? "incomplete" : "completed" });
    else if (value.startsWith(previous?.text ?? "")) {
      const delta = value.slice(previous?.text.length ?? 0);
      if (delta) this.send(`${prefix}.delta`, messageID, id, { messageId: id, blockId: id, delta, updateKind: "delta" });
    } else this.send(`${prefix}.snapshot`, messageID, id, { messageId: id, blockId: id, text: value, updateKind: "snapshot", completion: "streaming" });
    this.text.set(id, { text: value, completed, kind });
  }

  private tool(messageID: string, id: string, name?: string, input?: Record<string, unknown>, result?: { content?: ToolContent[]; error?: unknown; metadata?: Record<string, unknown> }): void {
    const key = `${messageID}:${id}`;
    const state = this.tools.get(key) ?? { name: name ?? "tool", input: {}, started: false };
    state.name = name ?? state.name;
    state.input = input ?? state.input;
    const command = /^(shell|bash|powershell)$/i.test(state.name) && typeof state.input.command === "string" ? state.input.command : undefined;
    const item = { id, type: command ? "commandExecution" : "dynamicToolCall", tool: state.name, command, arguments: state.input,
      ...(result ? { status: result.error ? "failed" : "completed", output: (result.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n"),
        content: result.content, metadata: result.metadata ?? {}, ...(result.error ? { error: result.error } : {}) } : { status: "running" }) };
    const payload = { toolCallId: id, kind: item.type, item };
    if (!state.started) { this.send("tool.started", messageID, key, payload); state.started = true; }
    if (result) {
      const fingerprint = JSON.stringify(item);
      if (fingerprint !== state.final) this.send(result.error ? "tool.failed" : "tool.completed", messageID, key, { ...payload, updateKind: "snapshot" });
      state.final = fingerprint;
    }
    this.tools.set(key, state);
  }

  private tokens(messageID: string, tokens: TokenUsageInfo, cost = 0): void {
    const fingerprint = JSON.stringify([tokens, cost]);
    if (this.usage.get(messageID) === fingerprint) return;
    this.usage.set(messageID, fingerprint);
    const input = tokens.input + tokens.cache.read + tokens.cache.write;
    this.send("usage.updated", messageID, messageID, { scope: "step", lastScope: "step", costScope: "step", cost, nativeUsage: tokens,
      tokenUsage: { last: { inputTokens: input, uncachedInputTokens: tokens.input, cachedInputTokens: tokens.cache.read, cacheWriteInputTokens: tokens.cache.write,
        outputTokens: tokens.output, reasoningTokens: tokens.reasoning, totalTokens: input + tokens.output + tokens.reasoning } } });
  }

  event(event: OpenCodeV2Event, turnId: string | null, parentID?: string): void {
    this.turnId = turnId; this.parentID = parentID; this.eventID = event.id;
    switch (event.type) {
      case "session.text.delta": case "session.reasoning.delta": {
        const data = event.data, kind = event.type === "session.text.delta" ? "text" : "reasoning";
        const id = `${data.assistantMessageID}:${kind}:${data.ordinal}`;
        this.content(data.assistantMessageID, data.ordinal, kind, (this.text.get(id)?.text ?? "") + data.delta, false);
        break;
      }
      case "session.text.ended": case "session.reasoning.ended": {
        const data = event.data;
        this.content(data.assistantMessageID, data.ordinal, event.type === "session.text.ended" ? "text" : "reasoning", data.text, true);
        break;
      }
      case "session.tool.input.started": this.tool(event.data.assistantMessageID, event.data.id, event.data.name); break;
      case "session.tool.called": this.tool(event.data.assistantMessageID, event.data.id, undefined, event.data.input); break;
      case "session.tool.success": this.tool(event.data.assistantMessageID, event.data.id, undefined, undefined, { content: event.data.content, metadata: event.data.metadata }); break;
      case "session.tool.failed": this.tool(event.data.assistantMessageID, event.data.id, undefined, undefined, { content: event.data.content, metadata: event.data.metadata, error: event.data.error }); break;
      case "session.step.ended": this.tokens(event.data.assistantMessageID, event.data.tokens, event.data.cost); break;
      case "session.retry.scheduled": this.emit({ type: "turn.retrying", turnId, payload: { attempt: event.data.attempt, next: event.data.at, message: event.data.error.message } }); break;
      case "session.message.content.updated": {
        const message = { id: event.data.messageID, content: event.data.content };
        this.assistant(message, true);
        break;
      }
    }
    this.eventID = undefined;
  }

  private assistant(message: Pick<SessionMessageAssistant, "id" | "content" | "finish" | "tokens" | "cost">, completed: boolean): void {
    // Native ordinals refer to positions in the assistant's content array, including tools.
    const current = new Set<string>();
    message.content.forEach((part, ordinal) => {
      if (part.type === "text" || part.type === "reasoning") {
        current.add(`${message.id}:${part.type}:${ordinal}`);
        this.content(message.id, ordinal, part.type, part.text, completed, message.finish === "length");
      } else if (part.type === "tool") {
        const state = part.state;
        this.tool(message.id, part.id, part.name, state.status === "streaming" ? undefined : state.input,
          state.status === "completed" ? { content: state.content, metadata: state.metadata } : state.status === "error" ? { content: state.content, error: state.error, metadata: state.metadata } : undefined);
      }
    });
    for (const key of this.text.keys()) if (key.startsWith(`${message.id}:`) && !current.has(key)) {
      this.text.delete(key);
      this.send("content.removed", message.id, key, { targetId: key });
    }
    if (completed && message.tokens) this.tokens(message.id, message.tokens, message.cost);
  }

  message(message: SessionMessageInfo, turnId: string | null, parentID?: string): void {
    this.turnId = turnId; this.parentID = parentID; this.eventID = undefined;
    if (message.type === "assistant") this.assistant(message, Boolean(message.time.completed));
  }

  session(session: SessionInfo, turnId: string | null): void {
    const fingerprint = JSON.stringify([session.tokens, session.cost]);
    if (this.usage.get(session.id) === fingerprint) return;
    this.usage.set(session.id, fingerprint);
    const tokens = session.tokens, input = tokens.input + tokens.cache.read + tokens.cache.write;
    this.emit({ type: "usage.updated", turnId, payload: { nativeItemId: session.id, nativeSessionId: session.id, scope: "session", costScope: "session", cost: session.cost,
      tokenUsage: { total: { inputTokens: input, uncachedInputTokens: tokens.input, cachedInputTokens: tokens.cache.read, cacheWriteInputTokens: tokens.cache.write,
        outputTokens: tokens.output, reasoningTokens: tokens.reasoning, totalTokens: input + tokens.output + tokens.reasoning } } } });
  }
}
