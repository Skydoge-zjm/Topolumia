# 科研节点与拓扑

业务：[科研模型](../../../product/business/research-model.md)、[文献](../../../product/business/literature-node.md)、[节点组](../../../product/business/node-groups.md)。验收：[工作区](../../../product/requirements/research-workspace.md)、[文献需求](../../../product/requirements/literature-node.md)。

## 职责与入口

节点模块负责身份、类型核心、详情聚合及逻辑关系。正文扩展交给 [内容块](../content-blocks/README.md)，正式写入交给 [变更服务](../research-changes/README.md)，活动与自动历程交给 [研究记录](../research-records/README.md)。

| 入口 | 用途 |
| --- | --- |
| [node-kinds.ts](../../../../src/domain/research/node-kinds.ts) 与 [content-blocks.ts](../../../../src/domain/research/content-blocks.ts) | 类型集合与核心校验；当前 paper 专属核心，其他类型通用核心 |
| [NodeObjectService](../../../../src/services/research/objects/node-service.ts) | 正式对象读取、核心与内容校验、拓扑投影 |
| [ResearchNodeService](../../../../src/services/topology/research-node-service.ts) | 面向用户的详情聚合与写操作门面，调用统一变更服务 |
| [nodes 路由](../../../../src/http/routes/research/nodes.ts) | 用户页面使用的 research-nodes / research-assets / research-relations 接口 |
| [NodeDetailPage](../../../../frontend/src/features/topology/details/NodeDetailPage.tsx) | 核心、内容块、关系、候选及实验结果的详情入口 |
| [TopologyService](../../../../src/services/topology/topology-service.ts) | 来源事实与正式科研投影的组合 |

精确 HTTP 路径和输入以路由与 Schema 为准。用户修改经 research-nodes / research-relations 门面进入统一变更服务；Agent 通过研究接口提出候选。拓扑服务提供正式投影，候选预览由研究候选服务负责，整理报告仅供建议。

## 核心与版本

节点有聚合 revision、coreRevision、blockCollectionRevision、relationRevision；分别支持整体删除、核心更新、内容顺序及关系并发校验。块自身另有 revision。

关系新增检查两端观察到的节点版本，并递增关系及节点版本；删除节点更新存活邻居，旧候选不能基于失效版本删除。详情读出的版本用于提交，不能在客户端自行推导新版本。

核心只保存类型稳定语义。paper 书目表单与 generic 核心当前均已实现；其他类型的专属核心尚未细化，不应沿用旧固定详情表单伪装已实现。

## 组与布局

[节点组模块](../node-groups/README.md) 负责组身份、角色/层级、共同正文和正式关系端点。[groupProjection](../../../../frontend/src/features/topology/model/groupProjection.ts) 仅产生视图；所有正式组修改经过共同变更服务。

节点与组的逻辑关系统一采用类型化端点；组的展开/收起仅改变视图，正式关系与成员组织分别保存。实现拓扑、节点详情或关系编辑时需同时覆盖组端点，不能将组强行加入 paper/experiment 等普通节点类型。

[TopologyCanvas](../../../../frontend/src/features/topology/TopologyCanvas.tsx) 与 [layout worker](../../../../frontend/src/features/topology/topology-layout.worker.ts) 管布局。保持既有位置和视口，不因检索、来源更新或节点内容修改不断重排。

实验结果由服务聚合 metric/link 块与关联运行，提供实际指标、曲线及外部入口；外部调用有上限与警告。它不是一个隐藏的旧 experiment 固定字段模型。

## 验证

- [object-consistency.test.ts](../../../../tests/research/object-consistency.test.ts)：正式写入、关系和版本一致性。
- [topology-layout.test.ts](../../../../tests/topology/topology-layout.test.ts)、[notebook.test.ts](../../../../tests/research/notebook.test.ts)：投影及组行为。
- [research-edit-integrity.spec.ts](../../../../frontend/e2e/research-edit-integrity.spec.ts)、[research-workspace.spec.ts](../../../../frontend/e2e/research-workspace.spec.ts)：用户详情、关系与持久化链路。

按任务选择验证，命令见 [测试指南](../../../playbooks/testing.md)。
