# Agent 工作台

业务：[协作方式](../../../product/business/agent-collaboration.md)，验收：[工作台需求](../../../product/requirements/agent-workbench.md)。这里负责会话执行、连续性、展示与用户控制，科研内容提交由 [变更模块](../research-changes/README.md) 负责。

## 深入主题

- [原生 Trace 与统一会话](trace-adapters.md)：供应商差异、事件身份和紧凑显示。
- [历史与媒体](sessions-and-media.md)：检查点、恢复、附件与 imageView。
- [原生配置](configuration.md)：项目文件、快照与启动映射。

## 核心入口

| 入口 | 责任 |
| --- | --- |
| [AgentSessionGateway](../../../../src/services/agents/agent-session-gateway.ts) | 运行实例、回合、权限请求、队列、停止及驱动生命周期 |
| [agent-driver](../../../../src/adapters/agents/shared/agent-driver.ts) | 原生驱动公共边界 |
| [agent-conversation](../../../../src/domain/agents/agent-conversation.ts) | 统一正文事件与回合模型 |
| [sessions 路由](../../../../src/http/routes/agents/sessions.ts) | 用户会话、媒体、持久化和事件入口 |
| [AgentPage](../../../../frontend/src/features/agents/AgentPage.tsx) | 页面装配；发送状态在 useAgentSubmission，正文在 AgentTranscript |

运行实例 ID、工作台会话 ID、研究会话 ID 和原生会话 ID 用途不同。继续回合不得因为原生重启而在 UI 新造会话；原生恢复失败则明确反馈。

OpenCode 2 是持续维护入口，使用独立 V2 客户端与适配器；OpenCode 1（旧版）仅保留既有能力，不开发新的命令功能。两版的配置、原生数据和协议各自独立，通过统一会话合同接入工作台。注册与版本选择见 [OpenCode 入口](../../../../src/adapters/agents/opencode/opencode-runtime.ts)。

## Agent 命令

工作台的命令合同由 [agent-commands.ts](../../../../src/domain/agents/agent-commands.ts) 定义。命令目录属于当前 Adapter 会话，前端只显示 Adapter 声明为 Web 可用的命令；命令以独立回合进入普通消息共用的队列、审批、停止、幂等和持久化链。回合记录保留提交 ID 与内容指纹，执行中、失败、历史事件滚动后和重启后的相同提交都不会重复执行；同一 ID 的不同内容会被拒绝。命令事件使用 `command.started`、`command.completed`、`command.failed`，命令名、参数、执行方式和原生标识保留在 payload 中。

当前统一支持 `/compact`。Codex Adapter 调用 `thread/compact/start`，Claude Code Adapter 将 `/compact` 作为已恢复非交互会话的原生命令输入，OpenCode 2 Adapter 调用 `session.compact`。Codex 还映射 `/review`、`/rename`、`/goal`，OpenCode 2 映射 `/undo`、`/redo`、`/fork`，并通过原生 `command.list` 发现项目命令。原生请求入队不等于完成：Adapter 关联原生执行身份，等到结束或失败后才释放队列；OpenCode 压缩还需确认原生执行已空闲。Skill 和项目命令的回复、工具调用与科研候选仍使用所属回合的普通处理链。

输入框的点击与 Enter 提交使用相同校验，普通消息 HTTP 入口也不能把未知斜杠命令送给模型。排队内容编辑后重新解析并校验，显示内容决定实际执行的消息或命令。命令提交共用前端 outbox，重试沿用原 ID，等待响应时保留新草稿，离线会话先恢复再执行。

Claude Code 在原生 `system/init` 返回可用于当前非交互会话的 `slash_commands` 后，动态补充可安全展示的 Skill/命令；账号、权限和终端控制命令被过滤。动态目录通过 `session.commands.updated` 事件同步给前端，历史会话保存最新快照。

命令目录不等于供应商 TUI 的完整斜杠清单。终端主题、快捷键、登录、权限、工作区删除和其他账号或主机控制不进入 Web 命令菜单。OpenCode 1 不实现新的命令发现或执行能力；其既有入口只维持原有会话行为。

## 不变量

- 不设置整个回合总执行倒计时；连接、探测与单次工具请求可独立限时。
- maxSessions 只限制运行实例，历史不会因关闭、归档或新建会话被自动裁剪。
- 终止处理要停止原生驱动并保存中断状态；不能无限等待驱动关闭后永远不会到来的完成通知。
- 当前权限在审批执行前校验；普通项目编辑与高风险/持久授权的边界见 [权限架构](../../architecture/authorization.md)。
- Skill 是可选方法指导，不是创建会话的先决条件。
- 回合所属科研候选通过真实回执关联，审批卡不依赖最终自然语言中是否出现候选 ID。

## 验证

[agent-command.test.ts](../../../../tests/agents/sessions/agent-command.test.ts)、[agent-session-lifecycle.test.ts](../../../../tests/agents/sessions/agent-session-lifecycle.test.ts)、[agent-message-queue.test.ts](../../../../tests/agents/sessions/agent-message-queue.test.ts)、[approval-authority.test.ts](../../../../tests/agents/sessions/approval-authority.test.ts) 验证后端边界。

前端按修改选 [AgentPage.spec.tsx](../../../../frontend/src/features/agents/AgentPage.spec.tsx)、[AgentApprovalCard.spec.tsx](../../../../frontend/src/features/agents/approvals/AgentApprovalCard.spec.tsx) 或相关会话模型测试。真实模型任务只在需要验证原生行为或科研质量时运行，不能用大量重复真实调用代替定位问题。
