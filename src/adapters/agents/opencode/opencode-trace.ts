import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2/client";

export interface OpenCodeEvent { type: string; turnId?: string | null; payload: Record<string, unknown> }
export type OpenCodeMessage = { info: Message; parts: Part[] };

// Only native messages and parts become conversation events. Protocol/status
// notifications do not create empty conversation rows.
export class OpenCodeTrace {
  readonly messages = new Map<string, Message>();
  readonly parts = new Map<string, Part>();
  private text = new Map<string, string>();
  private finished = new Set<string>();
  private tools = new Map<string, string>();
  private usage = new Map<string, string>();
  private finalText = new Map<string, string>();
  private removedParts = new Set<string>();
  private removedMessages = new Set<string>();
  private restoredParts = new Set<string>();
  private restoredMessages = new Set<string>();

  constructor(private emit: (event: OpenCodeEvent) => void, private turnId: () => string | null) {}

  message(info: Message, restored = false): void {
    if (this.removedMessages.has(info.id)) {
      if (!restored) return;
      this.removedMessages.delete(info.id); this.restoredMessages.add(info.id);
    }
    this.messages.set(info.id, info);
    for (const part of this.parts.values()) if (part.messageID === info.id) this.part(part);
    if (info.role === "assistant" && info.time.completed) {
      for (const part of this.parts.values()) if (part.messageID === info.id) this.complete(part);
      const fingerprint = JSON.stringify([info.cost, info.tokens]);
      if (this.usage.get(info.id) !== fingerprint) {
        this.usage.set(info.id, fingerprint);
        const inputTokens = info.tokens.input + info.tokens.cache.read + info.tokens.cache.write;
        this.send("usage.updated", { nativeItemId: info.id, cost: info.cost, costScope: "step", scope: "step", lastScope: "step", nativeUsage: info.tokens, tokenUsage: { last: {
          inputTokens, uncachedInputTokens: info.tokens.input, outputTokens: info.tokens.output, reasoningTokens: info.tokens.reasoning,
          totalTokens: info.tokens.total ?? inputTokens + info.tokens.output + info.tokens.reasoning,
          cachedInputTokens: info.tokens.cache.read, cacheWriteInputTokens: info.tokens.cache.write,
        } } });
      }
    }
  }

  part(part: Part, restored = false): void {
    if (this.removedParts.has(part.id)) {
      if (!restored) return;
      this.removedParts.delete(part.id); this.restoredParts.add(part.id);
    }
    this.parts.set(part.id, part);
    if (this.messages.get(part.messageID)?.role !== "assistant") return;
    if (part.type === "text" || part.type === "reasoning") {
      if (part.type === "text" && (part.synthetic || part.ignored)) return;
      const previous = this.text.get(part.id) ?? "";
      if (part.text !== previous) {
        if (!this.finished.has(part.id) && part.text.startsWith(previous)) this.send(part.type === "text" ? "assistant.message.delta" : "reasoning.summary.delta",
          { messageId: part.id, nativeItemId: part.id, nativeMessageId: part.messageID, delta: part.text.slice(previous.length) });
        else if (!this.finished.has(part.id)) this.send(part.type === "text" ? "assistant.message.snapshot" : "reasoning.summary.snapshot",
          { messageId: part.id, blockId: part.id, nativeItemId: part.id, nativeMessageId: part.messageID, text: part.text, completion: "streaming", updateKind: "snapshot" });
        this.text.set(part.id, part.text);
      }
      const message = this.messages.get(part.messageID);
      if (part.time?.end || this.finished.has(part.id) || (message?.role === "assistant" && message.time.completed)) this.complete(part);
    } else if (part.type === "tool") {
      // End commentary before inserting its tool call in the transcript.
      for (const prior of this.parts.values()) if (prior.messageID === part.messageID && prior.id !== part.id && prior.type === "text") this.complete(prior);
      this.tool(part);
    } else if (part.type === "patch") {
      this.sendOnce(part.id, "files.changed", { nativeItemId: part.id, files: part.files, hash: part.hash });
    } else if (part.type === "subtask") {
      this.sendOnce(part.id, "agent.delegated", { nativeItemId: part.id, agent: part.agent, description: part.description, prompt: part.prompt });
    }
  }

  delta(partID: string, delta: string): void {
    const part = this.parts.get(partID);
    if (this.finished.has(partID)) return;
    if (part?.type === "text" || part?.type === "reasoning") this.part({ ...part, text: part.text + delta });
  }

  removePart(partID: string): void {
    const part = this.parts.get(partID);
    this.parts.delete(partID); this.text.delete(partID); this.finished.delete(partID); this.finalText.delete(partID); this.tools.delete(partID);
    this.removedParts.add(partID); this.restoredParts.delete(partID);
    this.send("content.removed", { targetId: partID, nativeMessageId: part?.messageID, updateKind: "removed" });
  }

  removeMessage(messageID: string): void {
    this.removedMessages.add(messageID); this.restoredMessages.delete(messageID);
    for (const part of [...this.parts.values()]) if (part.messageID === messageID) this.removePart(part.id);
    this.messages.delete(messageID);
    this.send("content.removed", { nativeMessageId: messageID, updateKind: "removed" });
  }

  private tool(part: ToolPart): void {
    const state = part.state;
    const status = state.status;
    const fingerprint = JSON.stringify(state);
    const previous = this.tools.get(part.id);
    if (previous === fingerprint) return;
    const command = typeof state.input.command === "string" ? state.input.command : undefined;
    const item = { id: part.callID, type: command ? "commandExecution" : "dynamicToolCall", tool: part.tool, command,
      arguments: state.input, status, ...(status === "completed" ? { output: state.output, title: state.title, metadata: state.metadata, attachments: state.attachments } : {}),
      ...(status === "error" ? { error: state.error, metadata: state.metadata } : {}) };
    const payload = { toolCallId: part.callID, nativeItemId: part.id, nativeMessageId: part.messageID, kind: item.type, item };
    if (!previous) this.send("tool.started", { ...payload, status: "running" });
    this.tools.set(part.id, fingerprint);
    if (status === "completed" || status === "error") {
      this.finished.add(part.id);
      this.send(status === "error" ? "tool.failed" : "tool.completed", { ...payload, status: status === "error" ? "failed" : "completed" });
    }
    // OpenCode emits frequent running-state metadata snapshots. Preserve the
    // latest state locally and publish the complete result once, not 50 rows/s.
  }

  private complete(part: Part): void {
    if ((part.type !== "text" && part.type !== "reasoning") || !this.text.has(part.id)) return;
    this.finished.add(part.id);
    const text = this.text.get(part.id) ?? "";
    if (this.finalText.get(part.id) === text) return;
    this.finalText.set(part.id, text);
    const info = this.messages.get(part.messageID);
    const completion = info?.role === "assistant" && info.finish === "length" ? "incomplete" : "completed";
    this.send(part.type === "text" ? "assistant.message.completed" : "reasoning.summary.completed", { messageId: part.id, blockId: part.id, nativeItemId: part.id, nativeMessageId: part.messageID, text, completion, updateKind: "snapshot" });
  }

  private sendOnce(id: string, type: string, payload: Record<string, unknown>): void {
    if (this.finished.has(id)) return;
    this.finished.add(id);
    this.send(type, payload);
  }

  private send(type: string, payload: Record<string, unknown>): void {
    const restored = this.restoredParts.has(String(payload.nativeItemId ?? "")) || this.restoredMessages.has(String(payload.nativeMessageId ?? ""));
    this.emit({ type, turnId: this.turnId(), payload: { ...payload, ...(restored ? { restored: true } : {}) } });
  }

  replay(messages: OpenCodeMessage[]): void {
    for (const { info, parts } of messages) {
      if (this.removedMessages.has(info.id)) continue;
      // Insert message identity first, then preserve the native part order.
      this.messages.set(info.id, info);
      const ids = new Set(parts.map(part => part.id));
      for (const part of [...this.parts.values()]) if (part.messageID === info.id && !ids.has(part.id)) this.removePart(part.id);
      for (const part of parts) this.part(part);
      this.message(info);
    }
  }
}
