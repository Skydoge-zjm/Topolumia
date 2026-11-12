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

OpenCode 2 是持续维护入口，使用独立 V2 客户端与适配器；OpenCode 1（旧版）保留既有能力并冻结。两版的配置、原生数据和协议各自独立，通过统一会话合同接入工作台。注册与版本选择见 [OpenCode 入口](../../../../src/adapters/agents/opencode/opencode-runtime.ts)。

## 不变量

- 不设置整个回合总执行倒计时；连接、探测与单次工具请求可独立限时。
- maxSessions 只限制运行实例，历史不会因关闭、归档或新建会话被自动裁剪。
- 终止处理要停止原生驱动并保存中断状态；不能无限等待驱动关闭后永远不会到来的完成通知。
- 当前权限在审批执行前校验；普通项目编辑与高风险/持久授权的边界见 [权限架构](../../architecture/authorization.md)。
- Skill 是可选方法指导，不是创建会话的先决条件。
- 回合所属科研候选通过真实回执关联，审批卡不依赖最终自然语言中是否出现候选 ID。

## 验证

[agent-session-lifecycle.test.ts](../../../../tests/agents/sessions/agent-session-lifecycle.test.ts)、[agent-message-queue.test.ts](../../../../tests/agents/sessions/agent-message-queue.test.ts)、[approval-authority.test.ts](../../../../tests/agents/sessions/approval-authority.test.ts) 验证后端边界。

前端按修改选 [AgentPage.spec.tsx](../../../../frontend/src/features/agents/AgentPage.spec.tsx)、[AgentApprovalCard.spec.tsx](../../../../frontend/src/features/agents/approvals/AgentApprovalCard.spec.tsx) 或相关会话模型测试。真实模型任务只在需要验证原生行为或科研质量时运行，不能用大量重复真实调用代替定位问题。
