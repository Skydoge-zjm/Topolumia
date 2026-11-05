# 节点组接口、候选与提交

状态：已实现的接口与机制。领域与存储见 [模块](README.md)，投影见 [拓扑专题](topology-projection.md)，用户验收见 [需求](../../../product/requirements/node-groups.md)。

## 共同合同

组 Schema 与 `ResearchObjectRef`，供 HTTP、CLI、MCP、候选、前端及历史共同使用。定义加入现有 [共享接口](../../../../src/domain/research/interfaces/tools.ts)、[路由映射](../../../../src/domain/research/interfaces/routes.ts) 和 [Schema 注册](../../../../src/domain/research/interfaces/schema-registry.ts)，不维护手写参数副本。

精确字段以 Schema、CLI 帮助和生成的机器合同为准。本文解释范围、证据与提交语义。

## 人工 HTTP 门面

| 接口 | 责任 |
| --- | --- |
| GET/POST `/api/research-groups` | 分页索引 / 创建核心及可选成员；返回稳定组 ID |
| GET/DELETE `/api/research-groups/:id` | 组详情 / 确认后的非级联删除 |
| PATCH `/api/research-groups/:id/core` | 最小核心/来源修改，观察 coreRevision |
| GET/PATCH `/api/research-groups/:id/members` | direct/recursive 成员目录 / 直接成员增删、角色、说明与排序 |
| PATCH `/api/research-groups/:id/parent` | 修改 parentId，校验当前组及新旧父组的成员/层级版本 |
| PATCH `/api/research-groups/:id/primary-relations` | 选择或清除主入边/出边，观察 relationRevision |
| GET `/api/research-groups/:id/delete-impact` | 删除影响及 impactVersion，不执行删除 |
| `/api/research-objects/:kind/:id/content-blocks` | 节点/组共用的列表、新增、修改、归档与排序 |
| GET `/api/research-objects/:kind/:id/versions` | 共享对象的版本目录与按版本读取 |
| GET/POST `/api/research-relations`，PATCH/DELETE `/api/research-relations/:id` | 对象直接/范围对外关系列表、类型化端点、关系修改和删除 |

HTTP :kind 仅接受 node/group，ID 必须解码并在当前项目解析；不以字符串前缀选择任意表。节点核心/详情继续由科研节点门面负责；正文改用共同对象入口，删除旧的节点专用正文/版本路由及 `/api/topology/groups` 组写入合同，调用方同步更新。

详情返回核心、修订号、直接/递归计数、有限子组和正文目录、有限直接关系及后续查询提示，不内嵌全体成员全文。共同块集合 GET 返回分页目录，指定块 ID 的 GET 返回其内容；成员与关系目录也支持分页，组列表不递归展开所有成员。

PATCH 省略字段表示保留，允许的 null 表示清除；不得给编辑输入套用创建默认值。成员修改采用 add/update/remove/order 的增量语义：修改角色不会覆盖说明，新增成员不会替换整组。order 必须是全部当前直接成员 ID 的唯一排列。

递归目录返回去重节点及它的真实直接所属组/角色来源；不接受以 recursive 方式修改，因为一个范围可能经多个子组形成。直接节点与子组使用可辨别的条目类型，不能在普通 nodeId 数组中夹入组 ID。

关系新建必须提供已观察的正式端点整体版本；修改或删除还需观察关系 revision。端点以 `from/to: ResearchObjectRef` 表达，版本参数用 `expectedEndpointRevisions: [{ object, revision }]`，避免不同种类同 ID 冲突。端点变更通过删除旧关系、创建新关系，不能暗中把旧边改连另一对象。

组关系与成员对外关系列表分别可读，返回真实关系和端点；投影边 ID 不能提交到正式关系修改接口。

## Agent 读取与 CLI

### 读取入口

| 入口 | 本次调整 |
| --- | --- |
| get_context | 分开统计节点、组和逻辑边；成员关系不计为科学边，不加全组正文 |
| search | target 增加 groups；命中返回组身份、核心摘录、版本与 readHint |
| read_groups（新增） | mode=list/show/members；组索引、单组概要、成员目录 |
| read_nodes | 增加有界所属组提示；核心和正文读取语义不变 |
| neighbors | 输入改为 object 引用；scope=direct（默认）或 groupBoundary |
| read_blocks | 使用 owner 引用读节点/组块，保留 list/read、范围、版本和字符预算 |
| read_source | 核心字段 ref 包含类型化 owner，支持组完整核心字段的精确读取 |
| read_assets / transfer_asset | 复用既有授权与交接；块下载/导出的 target 使用 owner |
| get_schema | 增加可选 groupCore 主题；普通建组示例已足够，不强制先查 Schema |

read_groups 的 list 返回小页组摘要；show 必须提供 groupId，section 默认 overview，也可指定 deleteImpact 获取删除影响和阅读回执；members 提供 groupId、scope=direct/recursive 与游标。只新增这一项组专属读取工具，其余复用现有工具，不为每类组或角色新增工具。

CLI 对应 `group list`、`group show`、`group members`；`group show --section deleteImpact` 对应删除影响读取。现有 `block`、`neighbors`、候选和资产命令使用同一个类型化对象输入，帮助输出最短可运行示例。CLI 仍只调用 HTTP，不直接打开数据库。

scope=direct 的 neighbors 只查直接连接对象的正式边。groupBoundary 仅适用于组：令 R 为其后代组和递归成员节点，查询恰好一端在 R、另一端在 R 与当前组之外的正式逻辑边，保留真实端点和范围依据；它不重复返回当前组的直接关系。成员/父子包含关系不混入 neighbors。范围与方向过滤在分页前执行，返回范围版本和覆盖说明。

show 概要最多给出 6 个组正文摘要、有限子组提示、主入边/出边和数量；不自动读取成员正文。完整成员目录默认每页 20 项，单次上限 100，并服从现有 maxChars。list 默认预算 4000 字符、show/members 默认 6000 字符，上限遵循共享合同。

未展示的材料和成员有明确 omitted/nextCursor/readHint。目录可只返回较少项目，但不能把省略的成员标成不存在。计数按完整授权范围计算，不以当前页长度充当总数。

游标签名绑定项目、主体、候选范围、过滤条件和 scopeVersion。成员、层级或目录依赖的显示版本变化时拒绝旧游标；跨项目/主体不可复用。概览不产生“全部成员已读”的证据。

### 证据与读版本

读取回执以 owner 区分节点与组，记录所读部分（core/membership/block/relation）、修订号、范围和披露程度。groupCore 摘要回执与完整核心字段读取、成员摘要与完整成员目录必须可区分。

Agent 改组核心需当前核心依据，成员增删/角色修改需读当前直接成员目录；成员很多时分页读取，可提交自己已读到的局部成员增删，完整重排则需覆盖整个直接集合。写集合仍观察 membershipRevision，不能以部分读取推断未读成员应被删除。

重设 parentId 需读取当前组及新旧父组的必要核心/层级依据；完整层级由服务端校验，不要求模型遍历所有子孙正文。新增逻辑边需两端当前核心依据；修改块正文需该块当前内容依据。

删除需要当前组及 delete-impact 的对应回执和 impactVersion。审批接受时重新计算影响范围，依据过期则显式冲突；对已有候选内新建对象的编辑只检查候选 revision，不要求不存在的正式回执。

## 候选业务输入

复用 create_candidate/edit_candidate，在 [proposals](../../../../src/domain/research/changes/proposals.ts) 扩展：

- groups：新组核心、可选已有成员/父组、来源与嵌套自由块。
- groupChanges：groupId、必要观察版本、corePatch、成员增删/角色/顺序、parentId、主边及块的增量编辑。
- deleteGroups：groupId、整体版本、原因与 impactVersion。
- relations 采用类型化端点；relationChanges 支持说明/类型修改及删除，带关系和端点观察版本。

nodes/nodeChanges 与组输入可出现在同一候选，合计新增对象上限 8，块、文件及关系继续服从共享限额。所有新 ID 由系统分配，回执返回新节点、组、块和关系的稳定身份。

成员引用已存在或该候选已分配的节点 ID。先创建新节点取得回执，再通过 edit_candidate 新建组并加入这些 ID；关联刚创建的组同样使用回执 ID。普通已有节点建组只需一次 create_candidate。不要要求模型构造内部 clientRef、按数组索引猜 ID 或重述整份论文正文。

组创建后即使为空，也可在同一候选继续补充材料/成员/关系。修改和读取待审批组使用 candidateId，不能把预留组 ID 当成正式组。不同主体的未接受候选继续受可见性限制。

普通建组的输入示例（node ID 代表搜索或候选回执返回的实际身份）：

```json
{
  "reason": "组织基线与变体的对照实验",
  "groups": [{
    "core": { "nodeName": "Conditioning 消融实验" },
    "members": [
      { "nodeId": "node:baseline-id", "role": "baseline" },
      { "nodeId": "node:variant-id", "role": "variant" }
    ],
    "blocks": [{
      "title": "比较约定",
      "type": "richText",
      "payload": { "format": "markdown", "body": "使用相同数据划分与评估器，并保留各自的实际设置。" }
    }]
  }]
}
```

该输入不需要 category、角色枚举、设计节点、总结节点或完整成员正文。取得组 ID 后可在同一候选追加指向该组的正式关系和主边选择。

内部编译操作需要覆盖 addGroup/updateGroupCore、成员增删/重排、setGroupParent、setGroupPrimaryRelations、deleteGroup，以及 owner 化的共同块操作和类型化边操作。它们是执行层合同，不暴露为一套供 Agent 编写的低层工具。

## 统一提交与删除闭包

模拟和提交使用同一对象解析器，检查节点/组生命周期、项目、无环层级、角色/成员唯一、方向正确的主边、块来源与资产归属。候选预览输出组核心、成员变化、实际正文和关系差异，不能只显示“更新了分组”的计数。

delete-impact 至少包含：组整体版本、直接父组和子组版本、将删边及其版本、存活端点版本、主边清理和内容块版本。impactVersion 是该依赖集合的指纹。组删除保留成员正文，其正文更新不需要触发删除冲突；真正受影响的组/关系/组块变化必须使指纹变化。

影响清单很多时，返回完整计数、影响指纹和小页详情，支持同一 impactVersion 下继续分页。回执明确表示“读过影响摘要/所列范围”，不声称每个成员正文已读；后台仍对完整依赖闭包重新计算和校验。大规模删组预览也必须遵守读取预算。

节点删除的影响闭包也增加所有直接所属组。边删除清理端点上指向它的主边；移动子组同时更新新旧父组的成员/层级版本。关联更新与候选接受必须在一个 SQLite 事务中完成，不能依赖页面之后再发补救请求。

幂等请求和重试回执沿用现有机制。数据库或历史写入失败必须回滚组、块、关系和内存投影；不能出现“候选已接受但组没有保存”或“一半成员已移除”的状态。

## 授权、历程与刷新

读取要求 research.view。人工修改要求 research.applyChange；候选提出要求 research.proposeChange；审批沿用 review-policy；删除组或接受含删除组候选还需 research.withdrawOrSupersede。旧组接口只有 applyChange 即可删除的权限行为不作为新规格。

Agent 调用人工直写路径仍被拒绝。共享资产、条件响应、候选快照及分页读取先鉴权；类型化 owner 不能成为跨项目读取的捷径。

历程以一次领域提交记录组核心/成员/层级/主边/正文/关系的真实变化和人/Agent 来源；组不再同时从 NotebookStore 和统一事务各记一次。图布局或折叠不记领域变化。

组提交后失效项目拓扑、相关对象、组成员目录、候选、历史与引用计数的查询缓存。Agent 变更继续通过既有 session.research.updated 关联当前回合；普通正文 delta 不触发全组扫描。

## 最小端到端证据

对应端到端证据：人工建立设计→含两个成员的组→总结并展开收起；组上传真实表格并导出；Agent 候选增加组成员和材料后人工接受；多归属/层级调整与删除冲突；未授权 HTTP/CLI 调用失败；大量成员与长正文仍满足预算。

这些场景用领域测试、共享合同测试及少量浏览器工作流分工覆盖。无需为每种工具包装重复同一批断言，也不默认调用真实模型、外部 tracker 或训练任务。
