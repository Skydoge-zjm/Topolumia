# 内容块

内容块承载用户自由组织的扩展内容。科研节点与节点组通过共同 owner 引用拥有自由材料。业务见 [科研模型](../../../product/business/research-model.md)，用户验收见 [文献需求](../../../product/requirements/literature-node.md) 与 [节点组需求](../../../product/requirements/node-groups.md)。

## 机制导航

- [编辑与版本](editing.md)：局部修改、元数据保留、冲突和来源。
- [文件生命周期](file-lifecycle.md)：上传、存储、绑定、读取、派生和导出。
- [表格展示](table-rendering.md)：XLSX 与 TeX 的能力和边界。

## 权威入口

| 入口 | 责任 |
| --- | --- |
| [content-blocks.ts](../../../../src/domain/research/content-blocks.ts) | 类型、payload、sourceRefs、representations 的 Schema |
| [ResearchObjectService](../../../../src/services/research/objects/object-service.ts) | 共同正文校验、归属、版本与读取 |
| [operations.ts](../../../../src/domain/research/changes/operations.ts) | 内部块操作与观察版本；不是 Agent 常规输入 |
| [ContentBlockEditor](../../../../frontend/src/features/topology/details/ContentBlockEditor.tsx) | 人工编辑和最小修改提交 |
| [ContentBlockRenderer](../../../../frontend/src/features/topology/details/ContentBlockRenderer.tsx) | 正文与表示选择、文件分派 |

系统定义能力集合，不定义“贡献、方法、局限”等必填栏目。同一类型允许多块、自由标题与排序；纯文件表示也合法，不应强制生成空 payload。

内容块的 payload 表达可编辑内容，representations 表达原文件或补充表示，sourceRefs 表达证据定位；三者不能互相覆盖替代。默认主表示影响展示，不代表可以删除其他表示。

`experimentRecord` 仅用于实验节点，记录块拥有独立集合，提供 run、来源接收、曲线、准确数据、快照及跨材料引用。节点可只包含结果表格、图片或指标；只有添加记录块才启用工作台，多个块不隐式共享身份。累计记录与附件独立存储，payload 只保存来源与导入绑定；首版不提供共享集合。机制见[实验模块](../experiments-and-sources/README.md#内容块归属)。

通用 [ChartBlock](../../../../frontend/src/features/topology/details/ChartBlock.tsx) 按 dataBlockId 读取同一 owner 的内联表格，通过 config.x/config.y 指定列，未指定时使用首列和数值列。支持折线、柱状、散点和面积图，最多 8 个系列；分类横轴绘制有限行并提示截断。来源缺失、无内联数据或无数值列时明确反馈，不生成示例曲线。它与实验记录的过程曲线分别定义。

研究笔记的默认正文采用 `role: body` 的 `richText` 块，由 [NoteBodyWorkspace](../../../../frontend/src/features/topology/details/NoteBodyWorkspace.tsx) 提供直接写作入口。正文与附加块共用版本和顺序；归档主正文不会把附加文字静默提升为正文。

## 节点与组共同归属

[节点组模块](../node-groups/README.md) 定义 `owner: ResearchObjectRef`，正文的校验、编辑、来源、版本、预览与导出共用一套能力。块只属于一个对象；把节点加入组不复制块，组正文也不自动汇总成员全文。

共同归属需要贯穿路由、候选、查询、下载/导出目标和历史，不能只在编辑器增加 groupId 后继续由后端按 nodeId 查找。组材料使用相同类型、渲染器和图表读取规则。

修改方法见 [新增内容能力](../../../playbooks/add-content-block.md)；共享验证入口见 [测试指南](../../../playbooks/testing.md)。
