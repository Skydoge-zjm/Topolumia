# Agent、MCP、CLI 与科研服务

当前交付的是本机三种 Agent 接入和 stdio MCP；远程 MCP 服务尚未实现。[选择理由](../decisions/001-mcp-cli-boundary.md) 与当前机制分别维护。

## 统一链路

原生 Agent → stdio MCP → CLI 子进程 → HTTP → ResearchCommandService。

- MCP 负责类型化工具发现、调用校验、并发与单次请求预算、授权和审计。
- CLI 负责执行命令、受控文件交接、HTTP 请求及机器结果；不直接打开科研数据库。
- HTTP 解析当前凭据与项目范围；领域服务执行科研权限、对象读取、候选和提交规则。
- Skill 解释论文阅读方法与成果组织，按需读取文件，不复制工具合同，更不作为启动会话的前提。

权限贯穿入口与领域层，不能只留在 MCP；CLI 本身也不构成特权通道。

## 唯一合同与精确参考

| 事实 | 权威入口 |
| --- | --- |
| 工具名、Schema、预算、权限与命令映射 | [interfaces/tools.ts](../../../src/domain/research/interfaces/tools.ts) |
| HTTP 映射 | [interfaces/routes.ts](../../../src/domain/research/interfaces/routes.ts) |
| 合同版本与通用指导 | [research-interface.ts](../../../src/domain/research/research-interface.ts) |
| CLI 帮助与机器合同 | [cli.ts](../../../src/cli.ts)，构建后执行 `node dist/src/cli.js --help` / `--contract` |
| 候选业务输入 | [proposals.ts](../../../src/domain/research/changes/proposals.ts) |
| 实际执行 | [MCP Server](../../../src/mcp/research-server.ts)、[CLI Runner](../../../src/mcp/cli-runner.ts) |

文档不另列一份所有参数。新增能力从共享合同进入，避免 MCP、CLI 与 HTTP 手工维护三套不一致模型。

## 让核心信息进入上下文

get_context 提供小梗概，search 负责定位，read_nodes 返回核心和内容目录，read_blocks/read_assets/read_source 精确读取。摘要不冒充完整证据；正文范围、版本、分页、截断和不可用状态必须明确。

get_environment 只读缓存梗概，不枚举全部包。PDF 或图像未索引时，使用下载与原生读取提示，而不是重复尝试无法读取的文本接口。

create_candidate/edit_candidate 接受节点、内容块与增量修改的业务表达，内部编译成操作；Agent 不应手写内部事务序列。候选编辑不重述未修改正文。

## 节点组接口

[组接口](../modules/node-groups/interfaces-and-changes.md) 通过 read_groups、组搜索及现有候选提供组读写；共同内容块、核心字段、neighbors 与资产块目标使用类型化对象引用。组概览不隐式展开所有成员，成员目录按范围、版本和字符预算分页。

组直接关系与成员范围对外关系必须明确区分；读取组摘要不代表读过所有成员。候选编辑使用回执 ID 和相应范围的观察版本，不要求模型构造事务、猜临时引用或为建组加载新 Skill。MCP、CLI 与 HTTP 的精确字段仍从共享合同生成。

## 文件与会话绑定

[research-mcp-binding.ts](../../../src/agent/research-mcp-binding.ts) 为运行实例绑定项目、会话凭据、文件交接根和可用 Skill 快照。transfer 使用根下 out/ 上传、in/ 下载的相对路径，不传绝对路径或 base64 大段正文。

应用启动端口用配置文件；这里的会话环境变量是进程间凭据和绑定传递，不能混同为要求用户通过环境变量配置端口。

单次控制请求、CLI 调用和传输可以限时；Agent 整个研究回合不加应用总时限。

验证：[protocol.test.ts](../../../tests/research/interface/protocol.test.ts)、[上下文评估脚本](../../../scripts/diagnostics/evaluate-research-context.ts)。评估使用隔离的正式科研对象，检查检索命中、梗概预算、目录不泄漏完整正文，以及内容块和来源的精确读取；报告使用字符数，不能当作 token 或真实模型质量。真实任务质量还需检查原生 Trace 和最终候选内容。
