# 统一节点组模块

业务：[节点组](../../../product/business/node-groups.md)。行为与验收：[节点组需求](../../../product/requirements/node-groups.md)。本文描述当前实现。

## 范围与当前入口

节点组负责集合身份、成员与层级、组正文、正式关系端点和画布聚合。实验专属运行、训练控制与统计模型不在本次范围。

| 入口 | 当前责任 |
| --- | --- |
| [groups](../../../../src/domain/research/groups.ts)、[object-ref](../../../../src/domain/research/object-ref.ts) | 组核心、成员、角色、层级与共同引用合同 |
| [GroupObjectService](../../../../src/services/research/objects/group-service.ts) | 组身份、范围、层级校验与删除影响 |
| [ResearchObjectService](../../../../src/services/research/objects/object-service.ts) | 节点/组共用正文、来源、版本、关系解析 |
| [ResearchRepository](../../../../src/services/research/objects/repository.ts) | 项目隔离的节点、组、正文、版本与候选 |
| [ResearchChangeService](../../../../src/services/research/changes/change-service.ts)、[simulateChange](../../../../src/services/research/changes/simulate-change.ts) | 模拟、原子提交、关联删除、版本与资产 |
| [ProposalService](../../../../src/services/research/changes/proposal-service.ts) | 业务候选增量编译，统一人类审批 |
| [组路由](../../../../src/http/routes/research/groups.ts)、[共同对象路由](../../../../src/http/routes/research/objects.ts) | 人工组与正文/关系操作门面 |
| [GroupDetailPage](../../../../frontend/src/features/topology/groups/GroupDetailPage.tsx) | 成员、材料、关系、层级与删除界面 |
| [groupProjection](../../../../frontend/src/features/topology/model/groupProjection.ts)、[TopologyCanvas](../../../../frontend/src/features/topology/TopologyCanvas.tsx) | 稳定组入口、共享成员、边来源与折叠 |
| [共享接口](../../../../src/domain/research/interfaces/tools.ts)、[组查询](../../../../src/services/research/queries/group-queries.ts) | MCP/CLI、概要、成员与影响分页和回执 |

机制按独立任务展开：[拓扑与折叠](topology-projection.md)、[接口与变更](interfaces-and-changes.md)。正式文档不依赖本机任务稿。

## 对象与权威数据

统一引用为 `ResearchObjectRef = { kind: "node" | "group", id: string }`。它表示对象身份，不是科学节点种类：paper/experiment 等仍属于 node.kind，group 不加入普通节点的种类枚举。

组是可被正式关系引用的科研对象，拥有专属核心和共享内容块；成员集合使其具有聚合能力。它不是另一个通用科学论断类型，不将组正文塞到某个隐藏节点中。

组核心使用 nodeName（必填，1–240 字符）、summary（可选，最多 4000 字符）、category（可选，自定义文本，最多 80 字符）、tags（可选，最多 40 项，每项 80 字符）。不同时维护 title/description 的别名。说明可表达整体目的，详细协议与总结由自由块承载。

组对象包含以下概念；精确字段以单一共享 Schema 为准：

| 内容 | 表示与责任 |
| --- | --- |
| 身份 | id、projectId、生命周期、创建/修改主体及时间 |
| core / sourceRefs | 组核心和组级依据，复用来源校验 |
| members | 有序数组 `{ nodeId, role?, note? }`；数组决定顺序，组内 nodeId 唯一；role/note 自定义且可省略 |
| parentId | 一个同项目父组或 null；子组集合由该字段派生，不再维护另一份可写 childIds |
| primaryRelations | 可空的 incomingRelationId、outgoingRelationId；只指向 edges 中直接连接当前组且方向匹配的关系 |
| revisions | 整体、核心、成员/层级、内容集合与关系版本 |

每组最多 1000 个直接节点，层级最多 8 层；名称、成员、块和查询超过限额时给出明确错误，不静默截断保存。空组合法。成员角色上限 120 字符、说明上限 2000 字符；角色不设封闭枚举。

成员 nodeId 已明确指向 node，不同时接受组 ID；嵌套统一使用 parentId。递归范围按节点 ID 去重，同时保留直接加入位置和角色来源。

## 存储与服务边界

组写入 ResearchRepository 管理的 research_groups，采用与现有研究表相同的 project_id 隔离和 SQLite 事务。组及块历史由研究对象版本机制保存。NotebookStore 不保留第二份可写组对象。

正式关系仍由项目正式拓扑中的 edges 及其持久状态负责，新增类型化端点与关系 revision；不建立可独立修改的 group.boundaryRelations。组投影由研究对象派生，不能从前端视图反向写回。

拓扑刷新、候选清理、来源合并和只读整理器都需识别组及类型化端点：不能用普通节点类型白名单过滤掉组关系，也不能因来源暂缺而丢失正式组或成员。候选快照包含 nodes/groups/blocks/edges，正式图和候选图按范围分开解析。

内容块的归属统一为 `owner: ResearchObjectRef`，替代仅节点可用的 nodeId。块 ID、payload、representations、sourceRefs、review 和自身 revision 的语义统一；编辑、表格处理、资产下载与导出不得按节点/组复制两套实现。

GroupObjectService 负责组核心、成员/层级读取和版本校验；ResearchObjectService 解析对象身份、正文归属、生命周期及关系端点，NodeObjectService 保留普通节点专属身份、类型核心与投影。

所有组修改通过 ResearchChangeService；HTTP 门面和候选编译器都不能直接调用 NotebookStore.save("group")。事务协调对象、正式投影、资产保留和科研历程；失败需恢复内存投影。

资产的候选引用、正式引用和历史引用都识别组 owner。组级 PNG/XLSX/TeX/PDF 复用现有处理器；不扩大 chart 渲染或任意格式导出的承诺。

## 版本与影响范围

| 操作 | 必须观察的版本 | 更新范围 |
| --- | --- | --- |
| 核心、组级来源 | coreRevision | 核心及整体 revision |
| 直接成员、角色、顺序 | membershipRevision | 当前组的成员及整体 revision |
| 修改 parentId | 当前组与新旧父组的 membershipRevision（存在者） | 当前组、新旧父组的成员/层级及整体 revision |
| 组块修改 | 块 revision；排序/有序插入另需 blockCollectionRevision | 块、内容集合及组整体，遵循共享块操作规则 |
| 新建/修改/删除关系 | 正式端点的整体 revision；已有边还需边 revision | 关系、实际端点的 relationRevision 和整体 revision |
| 主入边/主出边 | 当前组 relationRevision | 当前组关系及整体 revision；不制造新边 |
| 删除组 | 当前组整体 revision 和确认的删除影响版本 | 组、实际受影响的父组/子组、关系及主边指针 |

组整体 revision 不因成员正文修改而递增。递归成员目录和范围查询使用由层级、成员及相关显示版本生成的 scopeVersion；旧分页游标与依据过期时显式返回冲突。scopeVersion 不是另一份可写修订号。

成员修改仅需要观察成员集合，不要求 Agent 先读所有成员正文。修改组块需读对应内容，摘要回执不能冒充完整阅读。关系及删除规则详见 [接口与变更](interfaces-and-changes.md)。

## 删除、层级与引用

删除组归档组自身和组块，删除其直接逻辑边并清理相关主边指针；所有节点保留。直接子组改接被删组的父组，根组的子组提升为根组。组的直接节点不会自动变成父组的直接成员，预览需说明父组递归范围的变化。

提交前读取并校验实际受影响对象，返回删除影响清单及 impactVersion；用户确认时携带该值，范围变化返回 409，禁止自动重试删除。新旧父组、子组和存活的关系端点更新对应版本并在同一事务提交。

删除节点由统一服务移除所有组中的直接引用，更新这些组的 membershipRevision；祖先组只更新派生范围。活动记录和科研历史使用对象身份/摘要快照，不要求被删对象仍然可读。

历史保留组核心、成员角色、层级、关系及组块版本引用；资产仍可能被历史或候选使用，不能按组删除磁盘目录。拒绝候选、从组移除、删除组和删除节点是不同的明确动作。

## 验证与边界

[节点组领域/接口测试](../../../../tests/research/node-groups.test.ts) 覆盖真实 MCP→CLI→HTTP、候选增量修订、类型化边、删除、跨项目、成员证据和预算；[对象一致性](../../../../tests/research/object-consistency.test.ts) 与 [历史](../../../../tests/research/history.test.ts) 覆盖共同提交与失败回滚。

[投影测试](../../../../frontend/src/features/topology/model/groupProjection.spec.ts) 覆盖重叠、嵌套、空组和边来源；[组浏览器工作流](../../../../frontend/e2e/node-groups.spec.ts) 覆盖创建、角色、真实 XLSX/TeX/PNG、导出、主边、收起/重载、审批与非级联删除。[文献编辑回归](../../../../frontend/e2e/research-edit-integrity.spec.ts) 检查共同正文与关系没有破坏文献编辑。

画布使用有限尺寸的容器缩略图和具有实际边界的展开容器。镜头与容器布局协同更新，外围保留外部关系；共享成员保留唯一对象身份。多人实时共同编辑、自动统计实验结果、通用 chart 内容块渲染及跨项目成员不在当前交付范围。正式字段和 CLI 参数由代码合同提供，文档不维护平行参数全集。
