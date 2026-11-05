# 原生 Trace 与统一会话模型

原生协议是输入事实，统一事件是应用合同，前端投影负责呈现。不能在 UI 根据供应商字符串猜测消息边界，也不能把多次思考累计拼成一段。

## 供应商入口

| Agent | 当前通道 | 适配入口 |
| --- | --- | --- |
| Codex | app-server，stdio JSON-RPC | [driver](../../../../src/adapters/agents/codex/codex-app-server-driver.ts)、[adapter](../../../../src/adapters/agents/codex/codex-agent-adapter.ts)、[reasoning](../../../../src/adapters/agents/codex/codex-reasoning.ts) |
| Claude Code | stream-json 输入/输出与原生权限请求 | [driver](../../../../src/adapters/agents/claude/claude-cli-stream-driver.ts)、[trace](../../../../src/adapters/agents/claude/claude-trace.ts)、[permission host](../../../../src/adapters/agents/claude/claude-permission-host.ts) |
| OpenCode | 本地 server 与 SDK 事件 | [server](../../../../src/adapters/agents/opencode/opencode-server.ts)、[adapter](../../../../src/adapters/agents/opencode/opencode-agent-adapter.ts)、[trace](../../../../src/adapters/agents/opencode/opencode-trace.ts) |

原生事件格式会随版本变化；修改时核对实际 CLI 版本和事件样例。这里记录职责，不复制完整供应商协议。

拓扑整理器的只读 Codex 执行与命令证据提取位于 [codex-exec-client](../../../../src/adapters/agents/codex/codex-exec-client.ts)，由 [curator driver](../../../../src/adapters/agents/codex/codex-curator-driver.ts) 调用，不承担用户会话。

## 统一语义

[agent-conversation.ts](../../../../src/domain/agents/agent-conversation.ts) 管正文事件，[agent-trace.ts](../../../../src/domain/agents/agent-trace.ts) 管诊断事件。回合、消息、内容段和工具调用采用稳定 ID，区分增量与最终快照、更新与完成，以及中间文本与最终回复。

同一内容的绝对快照覆盖其已有状态；不同消息/内容段不能因相邻而互相覆盖。工具输入和输出随调用更新，结束后留下有界结果，不把每个字符的 update 作为一行永久日志。

未知事件保留必要诊断，不应伪装为最终答复或在用户界面倾倒整份原始协议。失败要有可追溯的原生原因，不能只显示空白会话。

## 前端分组

[conversationProjector](../../../../frontend/src/features/agents/conversation/model/conversationProjector.ts) 与 [agentActivity](../../../../frontend/src/features/agents/conversation/model/agentActivity.ts) 组织展示；分组是视图，不修改事件身份。

连续思考/工具过程可汇总；类别图标区分思考、MCP 和命令。折叠摘要按 MCP 服务或工具类别计数，不罗列内部工具全名。Topolumia 自有调用显示双语业务描述，外部 MCP 保持其身份。

展开过程组后，每条命令或 MCP 调用仍先占一行，再独立展开有界输入与输出。结构化结果自行渲染，复制输出保留原文；最终回复才提供复制与科研笔记动作。

imageView 先捕获真实图像，再合并相邻图像视图，缩略图网格与大图分层显示；路径字符串不能替代图像。

## 验证

- [native-trace-alignment.test.ts](../../../../tests/agents/protocol/native-trace-alignment.test.ts) 与各 [供应商测试](../../../../tests/agents/providers/)：原生语义归一化。
- [conversationProjector.spec.ts](../../../../frontend/src/features/agents/conversation/model/conversationProjector.spec.ts)、[agentSession.spec.ts](../../../../frontend/src/features/agents/conversation/model/agentSession.spec.ts)：身份、快照和合并。
- [agent-tool-disclosure.spec.ts](../../../../frontend/e2e/agent-tool-disclosure.spec.ts)、[agent-image-gallery.spec.ts](../../../../frontend/e2e/agent-image-gallery.spec.ts)：实际展开层级与图像。

调查方法见 [Agent 排障](../../../playbooks/agent-debugging.md)。
