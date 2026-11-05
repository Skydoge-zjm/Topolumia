# 科研变更与候选

业务：[变更规则](../../../product/business/research-changes.md)。权限：[权限架构](../../architecture/authorization.md)。

## 职责与权威入口

[ResearchChangeService](../../../../src/services/research/changes/change-service.ts) 统一正式节点、节点组、共同内容块与关系提交。人工编辑通过 direct，Agent 提交候选并由人类 review 后执行。组的成员、层级和删除也在相同事务中处理，见 [组接口与变更](../node-groups/interfaces-and-changes.md)。

[ProposalService](../../../../src/services/research/changes/proposal-service.ts) 将 [业务输入](../../../../src/domain/research/changes/proposals.ts) 编译为 [内部操作](../../../../src/domain/research/changes/operations.ts)。Agent 使用对象级成果表达，无需组织内部事务和 clientRef 分配。组候选使用 groups/groupChanges/deleteGroups、共同 owner 块操作和类型化关系，不另建一套组候选或审批服务。

## 流程

1. 校验输入、项目范围和当前角色能力。
2. 基于正式对象、已读取证据和观察版本模拟操作，分配稳定对象身份，验证资产绑定。
3. 保存候选及其原因、来源和版本，提供目录与精确内容读取；候选 ID 与正式 ID 范围不可混用。
4. 增量编辑只修改提供部分，保留未提供正文；检查候选 revision，首次修改正式内容还需正式对象版本。
5. 人类审批时重新校验权限、版本和资产；接受在事务中提交对象、投影和科研历程，拒绝/暂缓仅更新相应状态。

幂等键与输入指纹约束同一次请求重试。网络失败后先查回执，不能通过换键重复创建一份相同成果，也不能用同键提交不同内容。

## 版本与证据

当前节点、核心、块、内容集合和关系分别有观察版本。新增关系检查两端，删除检查聚合版本并更新存活邻居；冲突返回 409，不自动覆盖。

组使用成员/层级版本、边自身 revision、类型化端点版本和删除影响指纹。组成员/角色变更、父组调整、主边、块归档和删除闭包都在同一事务处理；NotebookStore 与页面没有独立的组补写通道。各操作的精确观察范围见 [组版本表](../node-groups/README.md#版本与影响范围)。

读取回执绑定当前主体、研究会话、对象和版本。摘要读取不等同于正文读取；显式证据必须处于正确范围。Agent 修改正式内容需要相应读取依据，候选内部追加则沿候选版本处理。节点组扩展按 owner 区分核心、成员集合、块和关系依据，不要求修改一个角色前读取全部成员正文。

## 用户与会话展示

[ResearchCandidateCard](../../../../frontend/src/features/research/ResearchCandidateCard.tsx) 与 [TurnResearchChanges](../../../../frontend/src/features/agents/research/TurnResearchChanges.tsx) 提供统一审批与回合关联。接受需要 applyChange，拒绝/暂缓需要 review；共享 [review-policy](../../../../src/domain/research/review-policy.ts) 避免前后端漂移。

候选关联由真实工具回执增量维护；研究变更查询按当前会话索引、提供 ETag，session.research.updated 触发刷新。不要每个文本 delta 都重新扫描完整 Trace。

拓扑整理器保留建议报告职责，不能通过报告应用绕过候选和正式变更服务。

## 验证

- [protocol.test.ts](../../../../tests/research/interface/protocol.test.ts)：业务输入、精确读取、幂等与权限。
- [object-consistency.test.ts](../../../../tests/research/object-consistency.test.ts)：关系、删除、事务与旧路径移除。
- [agent-candidate-turns.test.ts](../../../../tests/agents/sessions/agent-candidate-turns.test.ts)：回合关联。
- [research-candidate-content.spec.ts](../../../../frontend/e2e/research-candidate-content.spec.ts)、[agent-inline-research.spec.ts](../../../../frontend/e2e/agent-inline-research.spec.ts)：内容与内联审批体验。
