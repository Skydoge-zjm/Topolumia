# 研究历程与活动纪要

业务依据：[科研模型](../../../product/business/research-model.md)，验收见 [工作区需求](../../../product/requirements/research-workspace.md)。研究记录按时间组织，不能以 Agent/MCP 日志替代。

## 两条记录链

自动历程由 [ResearchHistoryTracker](../../../../src/services/research/history/history-tracker.ts) 捕获领域行为，使用 [HistoryStore](../../../../src/services/research/history/history-store.ts) 持久化。节点、块、关系、候选审批、组和活动变化记录真实操作身份及前后内容。

活动纪要由 [ResearchRecords](../../../../src/services/research/research-records.ts) 与 [NotebookStore](../../../../src/services/research/notebook-store.ts) 管理；支持草稿、计划与确认，以及周期系列和具体一期。输入与精确种类见 [workspace-input](../../../../src/domain/research/workspace-input.ts)。

## 关键机制

- 正式科研提交和对应历史通过共同事务协调；记录身份区分人、Agent 与系统，尽可能保留会话/回合关联。
- 活动引用保存相关节点当时的身份和摘要快照，不依赖对象永远存在。
- 计划活动需要计划时间；确认纪要需要实际发生时间和正文，未来活动不能提前确认为已发生。
- 周期活动采用明确时区与 occurrenceKey，重复安排同一期不能产生多个实际记录。
- 文档编辑使用观察 revision，版本历史独立保存；记录不自动变成拓扑节点。

节点组由 [组变更](../node-groups/interfaces-and-changes.md) 通过共同事务产生历程，覆盖成员角色、层级、主边和组材料。组不经过 NotebookStore 记账；活动与周期记录由 NotebookStore 管理。组/关系删除后的历史保留类型化身份及版本依据，画布收起和筛选不进入科研历程。

前端入口：[ResearchRecordsPage](../../../../frontend/src/features/research/records/ResearchRecordsPage.tsx)、[ResearchHistoryPanel](../../../../frontend/src/features/research/history/ResearchHistoryPanel.tsx)。用户路由：[notebook.ts](../../../../src/http/routes/research/notebook.ts)。

## 验证

[history.test.ts](../../../../tests/research/history.test.ts)、[notebook.test.ts](../../../../tests/research/notebook.test.ts)、[record-recurrence.test.ts](../../../../tests/research/record-recurrence.test.ts) 验证归属、版本、快照和周期；[research-history.spec.ts](../../../../frontend/e2e/research-history.spec.ts) 检查用户可见历程。
