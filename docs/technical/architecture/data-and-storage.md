# 数据权威来源与存储

## 数据归属

| 数据 | 当前存储与责任 |
| --- | --- |
| 账号、项目、成员、登录、项目投影 | 全局 collaboration SQLite；[CollaborationStore](../../../src/services/platform/collaboration-store.ts) |
| 节点与组核心、块、对象/块版本、资产元数据、候选、读取回执、任务 | 同库按 project_id 隔离的研究表；[ResearchRepository](../../../src/services/research/objects/repository.ts) |
| 纪要、周期活动及其版本 | 同库 research_documents / versions；[NotebookStore](../../../src/services/research/notebook-store.ts) |
| 科研历程 | 同库项目化历史；[ResearchHistoryStore](../../../src/services/research/history/history-store.ts) |
| Agent 会话 | 每项目 agent-sessions/history.sqlite；[AgentHistoryStore](../../../src/services/agents/agent-history-store.ts) |
| 科研文件字节及派生预览 | 项目数据目录 research-assets；[资产服务](../../../src/services/research/assets/asset-service.ts) |
| 实验 run 与材料对应 | 实验节点对象和对象版本；过程记录块只引用 run 与资产，数值索引位于资产 derived 目录，可从归档原件重建 |
| 会话图片与原生 imageView 快照 | history.sqlite 同级 attachments；[会话媒体](../../../src/services/agents/agent-attachment-service.ts) |
| 项目设置、原生 Agent 配置 | settings.json、agent-config；[项目装配](../../../src/application/project-runtime.ts) 决定路径 |

默认应用数据位于 runtime；每项目路径由装配代码推导，不在文档复制所有路径规则。科研工作目录通常位于 workspaces 或用户指定位置，与应用数据分开。

## 正式对象与投影

正式节点核心和内容块在研究对象表中；拓扑是逻辑关系与对象摘要的投影，不是第二份可独立修改的正文。变更提交通过同一服务协调对象、关系、投影和历史。

来源刷新可以更新来源事实，但不能根据旧 marker、演示身份或对象是否来自人工而丢弃已保存科研对象。生产项目不依赖测试合成节点；需要演示拓扑的测试显式使用 [测试辅助](../../../tests/helpers/topology-fixture.ts)。

资产字节保存在应用资产根，数据库保存受控 storageKey 和元数据；API 返回领域身份与授权下载入口，不把磁盘路径当作通用读取权限。

## 生命周期与事务

SQLite 事务负责正式科研对象、状态与审计的协调；内存投影需要在失败时恢复，不能形成数据库失败而内存已提交的科研状态。事务辅助见 [sqlite-transaction.ts](../../../src/lib/sqlite-transaction.ts)。

会话历史使用 WAL 与 FULL synchronous。运行实例 maxSessions 不属于历史存储限制；有界 Trace 仅裁剪诊断事件，不裁剪回合正文和整个会话记录。保存失败必须可见和可重试。

科研资产、会话附件与 transfer 临时文件不是同一对象。候选绑定、正式绑定、草稿引用和历史引用决定保留；不能简单按文件年龄删除所有材料。

## 节点组归属

[节点组模块](../modules/node-groups/README.md) 的组对象由共同科研服务提交：ResearchRepository 管项目隔离的组及共同对象版本，NotebookStore 负责纪要和周期活动。组正式关系使用共同 edges，组不保存第二份可写边界边。

共同内容块使用类型化 owner 绑定 node/group，资产、候选、读取回执和历史按相同身份解析。统一事务提交组、成员、层级、块、关系、投影和历程；组删除不级联删除成员或真实文件。数据库、旧真实记录和资产不能在切换实现时自动清空，替换合同不等于授权重置数据。

## 检查与已知边界

- 研究一致性：[object-consistency.test.ts](../../../tests/research/object-consistency.test.ts)。
- 历史保留：[history-store.test.ts](../../../tests/agents/sessions/history-store.test.ts)。
- 恢复与保存：[reliability.test.ts](../../../tests/agents/sessions/reliability.test.ts)。
- 文件细节：[内容块生命周期](../modules/content-blocks/file-lifecycle.md)、[会话媒体](../modules/agent-workbench/sessions-and-media.md)。

这里描述当前存储机制，不承诺任意多进程共享同一应用数据目录。备份须覆盖数据库和文件，并正确处理 WAL，见 [运行维护](../../playbooks/operations.md)。
