# 系统地图

当前是 Node.js 后端与 React 前端构成的本地优先应用。后端同时服务 HTTP API、SSE 和已构建前端；Vite 提供开发页面与 API 代理。Node.js 的 SQLite 支撑账号、项目与科研数据，不是科研 Python 的一部分。

React 是唯一页面实现。frontend/src 保存前端源码，frontend/public 保存静态资源源码，Vite 将两者构建到 frontend/dist；后端直接从 frontend/dist 提供页面。根目录 dist 只包含后端构建产物，两者独立构建和清理。Agent 研究任务统一通过会话网关执行；拓扑整理器独立生成只读建议报告，使用自己的 Codex 执行模块。

## 主要责任

| 部分 | 责任与入口 |
| --- | --- |
| 应用装配 | [server.ts](../../src/server.ts) 注册路由、鉴权与关闭；[project-runtime.ts](../../src/application/project-runtime.ts) 隔离并装配项目服务 |
| 领域合同 | [research](../../src/domain/research/)、[agents](../../src/domain/agents/) 定义科研对象、变更、事件和接口约束 |
| 科研对象与变更 | [ResearchCommandService](../../src/services/research/research-command-service.ts) 组织读写服务；[变更服务](../../src/services/research/changes/change-service.ts) 统一正式提交 |
| 节点组 | [统一组模块](modules/node-groups/README.md) 管组身份、成员、层级、自由正文、正式关系和共同提交 |
| 来源与拓扑 | [AdapterRegistry](../../src/services/platform/adapter-registry.ts) 接入文件、Git、实验来源；拓扑组合来源投影与正式科研对象 |
| Agent 工作台 | [AgentSessionGateway](../../src/services/agents/agent-session-gateway.ts) 管原生会话；适配器归一化事件，历史和媒体独立保存 |
| Agent 科研接口 | [MCP Server](../../src/mcp/research-server.ts) → [CLI](../../src/cli.ts) → HTTP → 科研服务 |
| 前端 | [App.tsx](../../frontend/src/app/App.tsx) 路由与项目上下文；features 中按能力组织页面，共享会话与科研模型 |

## 核心数据流

人工编辑：详情页 → HTTP 节点接口 → ResearchNodeService → ResearchChangeService → 科研对象、投影及历史。

Agent 交付：原生工具调用 MCP → CLI 子进程 → HTTP 研究接口 → 候选；人类审批后由同一变更服务提交。Skill 提供研究方法，不能成为创建会话的硬依赖。

会话显示：原生协议 → 供应商适配器 → 统一事件 → 会话网关 → SQLite 检查点及 SSE → 前端投影。正文、工具快照、权限请求和候选关联各有身份，不依赖文本拼接猜测。

环境梗概：前端选择/探测 → 环境服务保存绑定与缓存 → MCP 读取缓存梗概 → Agent 自行探索和执行。

## 不能越过的边界

- 项目身份从鉴权上下文进入服务；数据库查询与缓存不能丢失 projectId。
- 科研正式写入只有统一提交机制；拓扑刷新和整理报告不能另建一条直接写入链。
- UI 与 MCP 可以提前约束输入，但实际执行的授权、版本和资产检查在后端。
- 科研文件、应用运行数据、会话媒体、文件交接目录有不同生命周期，不互相扫描混用。
- 项目构建中的 Promise 在成功和失败后都清理，失败关闭已创建资源，后续访问可重试。

深入：[存储](architecture/data-and-storage.md)、[权限](architecture/authorization.md)、[接入](architecture/agent-integration.md)、[前端状态](architecture/frontend-state.md)。精确字段以代码为准，模块入口由 [任务导航](../README.md) 选择。
