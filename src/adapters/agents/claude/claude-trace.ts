import type { AgentContentMetadata, AgentCompletion } from "../../../domain/agents/agent-conversation.js";

type Block = { id: string; type: "text" | "thinking"; text: string; index?: number; finalized: boolean; ended: boolean; completion?: AgentCompletion; published?: string; metadata: AgentContentMetadata };
type MessageState = { id: string; actor: AgentContentMetadata; blocks: Block[]; active: Map<number, Block>; tools: Map<number, { id: string; complete: boolean }>; incomplete?: boolean };

// Claude's assistant packets finish individual blocks. Their content array
// offsets are local to each packet; the pending stream supplies real indices.
export class ClaudeTrace {
  private states = new Map<string, MessageState>();
  private packets = new Set<string>();
  private taskActors = new Map<string, AgentContentMetadata | null>();
  private taskAgents = new Map<string, AgentContentMetadata>();
  private toolOwners = new Map<string, AgentContentMetadata>();
  private tools = new Set<string>();
  private main?: MessageState;
  private sequence = 0;

  constructor(private emit: (type: string, payload: Record<string, unknown>) => void, private turnId: string) {}

  private actor(packet): AgentContentMetadata {
    const parentToolUseId = packet.parent_tool_use_id ?? undefined;
    const known = packet.agent_id ? this.taskAgents.get(packet.agent_id) : parentToolUseId ? this.taskActors.get(parentToolUseId) : undefined;
    const owner = parentToolUseId ? this.toolOwners.get(parentToolUseId) : undefined;
    return { ...known, agentId: packet.agent_id ?? known?.agentId, parentToolUseId,
      parentAgentId: owner?.agentId ?? known?.parentAgentId, packetUuid: packet.uuid };
  }

  private state(id: string, actor: AgentContentMetadata): MessageState {
    const key = `${actor.agentId ?? actor.parentToolUseId ?? "main"}:${id}`;
    let state = this.states.get(key);
    if (!state) { state = { id, actor, blocks: [], active: new Map(), tools: new Map() }; this.states.set(key, state); }
    return state;
  }

  private block(state: MessageState, type: "text" | "thinking", index?: number, packetUuid?: string): Block {
    const block: Block = { id: packetUuid ? `claude:${packetUuid}:${type}:${this.sequence++}` : `claude:${this.turnId}:${this.sequence++}`,
      type, text: "", index, finalized: false, ended: false, metadata: { ...state.actor, nativeMessageId: state.id } };
    state.blocks.push(block);
    if (index !== undefined) state.active.set(index, block);
    return block;
  }

  private sendBlock(block: Block, mode: "delta" | "completed", text: string, completion: AgentCompletion = "completed") {
    if (mode === "completed") {
      const signature = JSON.stringify([text, completion, block.metadata.nativeMessageId, block.metadata.agentId, block.metadata.parentToolUseId]);
      if (block.published === signature) return;
      block.published = signature;
      block.completion = completion;
    }
    this.emit(`${block.type === "text" ? "assistant.message" : "reasoning.summary"}.${mode}`, {
      ...block.metadata, messageId: block.id, blockId: block.id, nativeItemId: block.id,
      ...(block.type === "thinking" ? { reasoningId: block.id } : {}),
      blockIndex: block.index, channel: block.type === "thinking" ? "thinking" : "text", updateKind: mode === "delta" ? "delta" : "snapshot",
      completion: mode === "delta" ? "streaming" : completion, ...(mode === "delta" ? { delta: text } : { text }),
    });
  }

  consume(packet): boolean {
    if (packet.uuid && this.packets.has(packet.uuid)) return true;
    if (packet.uuid) this.packets.add(packet.uuid);
    if (packet.type === "stream_event") {
      const event = packet.event ?? {};
      if (event.type === "message_start") this.main = this.state(event.message?.id ?? `turn:${this.turnId}`, {});
      const state = this.main ??= this.state(event.message_id ?? `turn:${this.turnId}`, {});
      if (event.type === "content_block_start") {
        const content = event.content_block ?? {};
        if (content.type === "text" || content.type === "thinking") this.block(state, content.type, event.index);
        if (content.type === "tool_use") {
          state.tools.set(event.index, { id: content.id, complete: false });
          this.startTool(content, {}, { blockIndex: event.index, nativeMessageId: state.id });
        }
      }
      if (event.type === "content_block_delta") {
        const delta = event.delta ?? {};
        if (delta.type === "text_delta" || delta.type === "thinking_delta") {
          const type = delta.type === "text_delta" ? "text" : "thinking";
          const active = state.active.get(event.index ?? 0);
          const block = active?.type === type ? active : this.block(state, type, event.index ?? 0);
          if (!block.finalized && !block.ended) {
            const text = type === "text" ? delta.text ?? "" : delta.thinking ?? "";
            block.text += text; this.sendBlock(block, "delta", text);
          }
        } else if (delta.type === "input_json_delta") {
          const tool = state.tools.get(event.index);
          if (tool) this.emit("tool.updated", { toolCallId: tool.id, nativeMessageId: state.id, delta: delta.partial_json ?? "", deltaField: "input", updateKind: "delta" });
        }
      }
      if (event.type === "content_block_stop") {
        const block = state.active.get(event.index);
        if (block && !block.finalized) { block.ended = true; this.sendBlock(block, "completed", block.text); }
      }
      if (event.type === "message_delta" && ["max_tokens", "length"].includes(event.delta?.stop_reason)) state.incomplete = true;
      if (event.type === "message_stop") this.endMessage(state, "interrupted");
      return true;
    }
    if (packet.type === "assistant") {
      const actor = this.actor(packet);
      const id = packet.message?.id ?? packet.uuid ?? `turn:${this.turnId}`;
      const state = !actor.agentId && !actor.parentToolUseId && this.main?.id.startsWith("turn:")
        ? this.main : this.state(id, actor);
      for (const content of packet.message?.content ?? []) {
        if (content.type === "text" || content.type === "thinking") {
          const block = state.blocks.find(block => block.type === content.type && !block.finalized)
            ?? this.block(state, content.type, undefined, packet.uuid);
          block.metadata = { ...actor, nativeMessageId: id };
          block.finalized = true;
          block.text = content.type === "text" ? content.text ?? "" : content.thinking ?? "";
          this.sendBlock(block, "completed", block.text, packet.aborted ? "interrupted" : "completed");
        } else if (content.type === "tool_use") {
          this.startTool(content, actor, { nativeMessageId: id, inputComplete: true });
          for (const tool of state.tools.values()) if (tool.id === content.id) tool.complete = true;
        }
      }
      return true;
    }
    if (packet.type === "user") {
      if (!Array.isArray(packet.message?.content)) return true;
      for (const block of packet.message.content) if (block.type === "tool_result") {
        this.emit(block.is_error ? "tool.failed" : "tool.completed", { ...this.actor(packet), toolCallId: block.tool_use_id,
          kind: "tool_result", rawOutput: block.content, completion: block.is_error ? "failed" : "completed", status: block.is_error ? "failed" : "completed" });
      }
      return true;
    }
    if (packet.type === "system" && ["task_started", "task_progress", "task_notification", "task_updated"].includes(packet.subtype)) {
      const actor = { agentId: packet.task_id, parentToolUseId: packet.tool_use_id, agentName: packet.description ?? packet.agent_type };
      this.taskAgents.set(packet.task_id, actor);
      if (packet.tool_use_id) {
        const known = this.taskActors.get(packet.tool_use_id);
        this.taskActors.set(packet.tool_use_id, known === null || known && known.agentId !== actor.agentId ? null : actor);
      }
      this.emit("agent.activity", { ...actor, status: packet.status ?? (packet.subtype === "task_notification" ? "completed" : "running"), description: packet.description, summary: packet.summary });
      return true;
    }
    if (packet.type === "tool_progress") {
      this.emit("tool.updated", { ...this.actor(packet), toolCallId: packet.tool_use_id, elapsedSeconds: packet.elapsed_time_seconds, status: "running", updateKind: "snapshot" });
      return true;
    }
    return false;
  }

  private startTool(content, actor: AgentContentMetadata, metadata = {}) {
    const key = content.id;
    this.toolOwners.set(key, actor);
    this.emit(this.tools.has(key) ? "tool.updated" : "tool.started", { ...actor, ...metadata, toolCallId: key,
      title: content.name, kind: content.name, rawInput: content.input ?? {}, status: "running", updateKind: "snapshot" });
    this.tools.add(key);
  }

  private endMessage(state: MessageState, completion: AgentCompletion) {
    if (state.incomplete) {
      const last = state.blocks.at(-1);
      if (last) this.sendBlock(last, "completed", last.text, "incomplete");
    }
    for (const block of state.blocks) if (!block.finalized) {
      this.sendBlock(block, "completed", block.text, block.completion ?? (block.ended ? "completed" : completion));
      block.ended = true;
    }
    for (const tool of state.tools.values()) if (!tool.complete) {
      this.emit("tool.failed", { toolCallId: tool.id, nativeMessageId: state.id, completion: "incomplete", status: "incomplete", error: "原生工具输入未完整生成。" });
      tool.complete = true;
    }
  }

  finish(completion: AgentCompletion = "completed") {
    if (completion === "incomplete") {
      const last = [...this.states.values()].reverse().find(state => !state.actor.agentId && !state.actor.parentToolUseId);
      if (last) last.incomplete = true;
    }
    for (const state of this.states.values()) this.endMessage(state, completion === "completed" ? "incomplete" : completion);
  }
}
