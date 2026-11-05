# Topolumia 项目知识库

这里保存项目有效结论、开发方法和有限生命周期的任务状态。先按任务选入口，不需要顺序读完。产品目前以本机运行作为验证范围；团队授权能力已有实现，远程 MCP 与完整托管部署尚未交付。

## 按任务进入

| 你要做什么 | 优先阅读 | 何时继续展开 |
| --- | --- | --- |
| 了解产品、用户与范围 | [产品总览](product/overview.md) | 需要具体规则时进入业务；准备验收时进入需求 |
| 理解整个系统 | [技术总览](technical/overview.md) | 按数据流进入相关模块，不必遍历目录 |
| 设计科研节点 | [科研模型](product/business/research-model.md) → [工作区需求](product/requirements/research-workspace.md) | 修改实现时读 [节点模块](technical/modules/research-nodes/README.md) |
| 开发节点组、组关系与展开收起 | [节点组业务](product/business/node-groups.md) → [节点组需求](product/requirements/node-groups.md) | 从 [组模块](technical/modules/node-groups/README.md) 进入投影、接口与统一提交；按需进入接口与投影专题 |
| 做好文献节点与阅读成果 | [文献业务](product/business/literature-node.md) → [文献需求](product/requirements/literature-node.md) | 查看节点模块与 [内容块模块](technical/modules/content-blocks/README.md) |
| 修改上传、编辑、表格预览 | [内容块模块](technical/modules/content-blocks/README.md) | 文件归属看生命周期；冲突与元数据看编辑机制 |
| 修改候选、接受、拒绝或删除 | [科研变更规则](product/business/research-changes.md) → [变更模块](technical/modules/research-changes/README.md) | 涉及角色或会话凭据时读 [权限架构](technical/architecture/authorization.md) |
| 修改会话、工具显示或原生事件 | [会话需求](product/requirements/agent-workbench.md) → [工作台模块](technical/modules/agent-workbench/README.md) | 深入 Trace、历史、图片或原生配置的子文档 |
| 扩展 Agent 的科研工具与 Skill | [Agent 协作规则](product/business/agent-collaboration.md) → [接入架构](technical/architecture/agent-integration.md) | 修改共享合同，按 [验证指南](playbooks/testing.md) 选择接口测试 |
| 修改研究记录与周期活动 | [科研模型](product/business/research-model.md) → [研究记录模块](technical/modules/research-records/README.md) | 不把会话日志当成科研历程 |
| 修改 Python、Conda、SSH 或环境上下文 | [环境业务](product/business/research-environment.md) → [环境需求](product/requirements/tools-and-environments.md) → [环境模块](technical/modules/tools-and-environments/README.md) | 区分查看、探测和设为当前 |
| 修改实验指标、来源刷新 | [实验与来源模块](technical/modules/experiments-and-sources/README.md) | 写入科研对象仍遵循统一变更机制 |
| 启动、测试、排障、配置与备份 | [开发](playbooks/development.md) · [测试](playbooks/testing.md) · [运行维护](playbooks/operations.md) · [Agent 排障](playbooks/agent-debugging.md) | 只执行当前任务所需操作 |
| 新增一种内容块能力 | [扩展方法](playbooks/add-content-block.md) | 从语义到往返编辑与文件验证，不只增加表单 |
| 维护文档或恢复长任务 | [维护约定](playbooks/documentation.md) | 本机任务状态放 docs/work，不进入默认知识读取链 |

## 归属与状态

- product/business 定义领域概念与规则；product/requirements 定义场景、行为和验收。需求中的“已实现”与“待实现”单独说明。
- technical 描述当前实现、跨模块约束与重要取舍；目标设计存在差距时明确标注，不用 current 暗示全部完成。
- playbooks 保存重复使用的方法，不复制业务规则或参数全集。
- work 保存特定任务的计划与交接状态。小任务无需建立；尚未定案的重大方案在工作项内讨论，生效后沉淀到主文档。

一个定义只在一处维护，其余通过链接引用。接口与字段的精确权威来源是 Schema、类型和命令帮助；文档解释语义、原因、边界和必要验证。

## 技术专题与决策

- [数据与存储](technical/architecture/data-and-storage.md)、[权限边界](technical/architecture/authorization.md)、[Agent 接入](technical/architecture/agent-integration.md)、[前端状态](technical/architecture/frontend-state.md)。
- [MCP 与 CLI 分工](technical/decisions/001-mcp-cli-boundary.md)、[类型核心与自由内容](technical/decisions/002-typed-core-and-content.md)、[科研记录与执行日志分离](technical/decisions/003-research-history-boundary.md)。

## 公开范围与维护

本入口、product、technical 和 playbooks 是正式项目文档，与代码在同一 Git 仓库维护并随源码公开。[根开发入口](../AGENTS.md) 保持简短，项目知识按任务从本页展开。

docs/work 下的任务记录和 docs/references 下的第三方参考资料仅保留本机，由 Git 与源码导出排除。正式文档不能依赖这些目录中的文件；有长期价值的结论应写入对应产品、技术或操作文档。

从源码根执行 `npm run docs:check`，检查本地链接、锚点、导航可达性、入口预算及对本机资料的依赖。检查规则适用于本地工作区、克隆副本和源码导出，不要求本机目录存在。文档检查不代表产品行为已经通过验收，具体维护方式见 [维护约定](playbooks/documentation.md)。
