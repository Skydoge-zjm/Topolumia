# 原生 Trace 与统一会话模型

原生协议是输入事实，统一事件是应用合同，前端投影负责呈现。不能在 UI 根据供应商字符串猜测消息边界，也不能把多次思考累计拼成一段。

## 供应商入口

| Agent | 当前通道 | 适配入口 |
| --- | --- | --- |
| Codex | app-server，stdio JSON-RPC | [driver](../../../../src/adapters/agents/codex/codex-app-server-driver.ts)、[adapter](../../../../src/adapters/agents/codex/codex-agent-adapter.ts)、[reasoning](../../../../src/adapters/agents/codex/codex-reasoning.ts) |
| Claude Code | stream-json 输入/输出与原生权限请求 | [driver](../../../../src/adapters/agents/claude/claude-cli-stream-driver.ts)、[trace](../../../../src/adapters/agents/claude/claude-trace.ts)、[permission host](../../../../src/adapters/agents/claude/claude-permission-host.ts) |
| OpenCode 1（旧版） | 独立本地 server 与固定 V1 SDK，仅维持既有会话能力，不开发新命令功能 | [server](../../../../src/adapters/agents/opencode/v1/opencode-server.ts)、[adapter](../../../../src/adapters/agents/opencode/v1/opencode-agent-adapter.ts)、[trace](../../../../src/adapters/agents/opencode/v1/opencode-trace.ts) |
| OpenCode 2 | 独立本地 server、V2 client、实时 SSE 与持久日志补偿 | [server](../../../../src/adapters/agents/opencode/v2/opencode-server.ts)、[adapter](../../../../src/adapters/agents/opencode/v2/opencode-agent-adapter.ts)、[trace](../../../../src/adapters/agents/opencode/v2/opencode-trace.ts) |

[OpenCode 注册入口](../../../../src/adapters/agents/opencode/opencode-runtime.ts) 只分派版本和模型发现。两版实现不相互导入，各自拥有 SDK、权限和消息投影；V2 的 session.text/reasoning/tool 事件按原生 assistant ID 与内容 ordinal 建立稳定身份，最终快照修复增量，恢复不增加工具次数。V1 继续提供既有能力，后续优化与维护集中在 V2。

原生事件格式会随版本变化；修改时核对实际 CLI 版本和事件样例。这里记录职责，不复制完整供应商协议。

## 命令执行边界

工作台命令不是供应商 TUI 命令的透传层。Adapter 只暴露经过筛选的 Web 命令，并将原生命令映射到对应协议：Codex 的 `/compact` 使用 App Server `thread/compact/start`，`/review`、`/rename`、`/goal` 使用对应 thread/review 方法；Claude Code 的 `/compact` 使用 `--print`/`stream-json` 恢复会话中的命令输入；OpenCode 2 的 `/compact` 使用 `session.compact`，`/undo`、`/redo`、`/fork` 使用 session API。命令回合保留原生身份，回复与审批走普通回合事件；最终状态以统一 `command.*` 事件进入会话。

Codex 压缩从 `turn/started` 获取原生回合 ID，审查从 `review/start` 的响应获取 ID；提前到达的通知在关联后处理，回合结束前不能释放队列。启动响应超时、丢失或没有有效回合 ID 时，若尚无权威结束通知，先关闭所拥有的原生进程再报告失败，恢复时继续原生会话；已确认的原生结束结果与明确拒绝分别保留其完成状态和可重用性。单次启动请求受连接预算限制，不为整个回合设置总执行时限。`/review` 默认审查未提交内容，附带文字时使用自定义审查目标。`/goal` 设置与清除携带用户操作来源，查询结果显示目标正文。

Claude Code 从准备配置前登记回合，准备阶段与原生执行阶段共用停止和关闭状态。停止后不得再发送用户输入；关闭要等待尚未完成的配置准备、进程启动与清理。配置准备失败也必须释放运行记录，不能留下无法继续的忙状态。

OpenCode 2 压缩使用预先分配的原生输入 ID，等待压缩结束并确认执行空闲，原生失败必须传回网关；连接恢复时从原生消息与日志修复完成状态。项目命令从原生入队事件或新增用户消息关联输入 ID，输出不能归到前一个回合；命令与普通 Prompt 共用模型校验，入队前应用本次提交的模型和推理强度。停止先移除待执行输入，再中断原生执行。

OpenCode 2 的 `/undo`、`/redo` 按原生 `session.revert` 位置逐个用户回合移动，完整历史保留供恢复使用，不能反复选择同一个最后用户消息。`/fork` 校验项目目录并准备新历史和事件流后才切换身份；准备失败时保留原会话 ID、关闭运行实例并允许恢复，网关与 Adapter 不得各自使用不同的原生会话。

终端界面、账号、权限、外部控制和破坏性命令不进入菜单。未知命令不能回退为普通 Agent 提示词；OpenCode 2 的自定义命令若包含 Shell 模板，还必须遵守其独立的权限和来源边界。OpenCode 1 不新增命令适配。

拓扑整理器的只读 Codex 执行与命令证据提取位于 [codex-exec-client](../../../../src/adapters/agents/codex/codex-exec-client.ts)，由 [curator driver](../../../../src/adapters/agents/codex/codex-curator-driver.ts) 调用，不承担用户会话。

## 统一语义

[agent-conversation.ts](../../../../src/domain/agents/agent-conversation.ts) 管正文事件，[agent-trace.ts](../../../../src/domain/agents/agent-trace.ts) 管诊断事件。回合、消息、内容段和工具调用采用稳定 ID，区分增量与最终快照、更新与完成，以及中间文本与最终回复。

同一内容的绝对快照覆盖其已有状态；不同消息/内容段不能因相邻而互相覆盖。工具输入和输出随调用更新，结束后留下有界结果，不把每个字符的 update 作为一行永久日志。

未知事件保留必要诊断，不应伪装为最终答复或在用户界面倾倒整份原始协议。失败要有可追溯的原生原因，不能只显示空白会话。

## 前端分组

[conversationProjector](../../../../frontend/src/features/agents/conversation/model/conversationProjector.ts) 与 [agentActivity](../../../../frontend/src/features/agents/conversation/model/agentActivity.ts) 组织展示；分组是视图，不修改事件身份。

连续思考/工具过程可汇总；类别图标区分思考、MCP 和命令。折叠摘要按 MCP 服务或工具类别计数，不罗列内部工具全名。Topolumia 自有调用显示双语业务描述，外部 MCP 保持其身份。

展开过程组后，每条命令或 MCP 调用仍先占一行，再独立展开有界输入与输出。会话和完整 Trace 的折叠项只挂载摘要，展开时才渲染正文与结构化结果；复制输出保留原文，最终回复提供复制与科研笔记动作。

长会话保留全部消息和搜索数据，屏外正文用测得高度的占位区维持滚动范围，在阅读区附近才解析 Markdown 与公式。流式消息始终即时渲染；搜索和消息导航保留原有锚点，跳到历史消息后再挂载正文。屏外正文卸载不改变事件或消息身份。

imageView 先捕获真实图像，再合并相邻图像视图，缩略图网格与大图分层显示；路径字符串不能替代图像。

## 验证

- [native-trace-alignment.test.ts](../../../../tests/agents/protocol/native-trace-alignment.test.ts) 与各 [供应商测试](../../../../tests/agents/providers/)：原生语义归一化。
- [conversationProjector.spec.ts](../../../../frontend/src/features/agents/conversation/model/conversationProjector.spec.ts)、[agentSession.spec.ts](../../../../frontend/src/features/agents/conversation/model/agentSession.spec.ts)：身份、快照和合并。
- [agent-tool-disclosure.spec.ts](../../../../frontend/e2e/agent-tool-disclosure.spec.ts)、[agent-image-gallery.spec.ts](../../../../frontend/e2e/agent-image-gallery.spec.ts)：实际展开层级与图像。

调查方法见 [Agent 排障](../../../playbooks/agent-debugging.md)。
