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

get_context 提供项目梗概。带短查询时，它同时返回最多三个匹配对象或来源及读取提示。search 提供完整检索分页，read_nodes 返回核心与内容目录，read_blocks、read_assets、read_source 按范围读取证据。索引文件原文附带可写入候选的 sourceRef。读取回执向 Agent 提供 ID、对象、版本、范围与披露程度，服务端另行保留身份、会话与时间供审计。

search 也接受 2 至 6 个独立查询，在同一项目视图和共享字符预算内分别排名。每组包含查询索引、命中总数与已交付结果，扩大某一组时可接着做单项查询。节点检索可以匹配其直接所属组与成员角色。chart 的 manifest 提供图表类型、数据块 ID 和可执行的取值提示。image 的 manifest 提供作者填写的替代文本和说明预览，长说明用返回的文本读取参数分段取得。

get_environment 只读缓存梗概，不枚举全部包。PDF 或图像未索引时，使用下载与原生读取提示，而不是重复尝试无法读取的文本接口。

`read_experiment` 按 runs → metrics → series 逐级定位运行、指标与原始点；materials 返回配置、表格行和日志的版本化关联及可直接调用的读取提示。inspect 检查已上传的原生记录，compare 提供同名指标的临时比较。曲线绘图采样与精确点读取分别返回；来源已采样时明确标记。运行和材料的观察回执只覆盖实际交付的 ID，读取一页不能授权修改未读的运行。具体机制见 [实验模块](../modules/experiments-and-sources/README.md)。

create_candidate 和 edit_candidate 接受节点、内容块与增量修改的业务表达。候选回执中每个已列出的块均带有可执行的读取参数，包含候选 ID、所属对象、块版本与适合的视图。追加材料时只提交发生变化的字段。get_schema 的 example 视图给出简短可用输入，schema 视图提供完整字段约束。

候选引用的正式来源换版后，科研读取仍可展示草稿，并在 scope 中给出过期来源计数。候选概览提供首个变化来源和重读提示。编辑时提交当前版本的来源读取回执，会更新同一来源的旧版本固定依据，原修订仍保留旧回执。显式证据 ID、主体、会话、读取范围及实际接受时的来源版本继续校验。候选的 nodes、groups 和 evidence 章节可沿游标分页。

### 实验持续数据读取

Agent 从实验的内容目录定位具体记录块/集合/run，再经 read_experiment 读取指标和准确范围。只有结果表格的实验走普通块/资产接口。人和 Agent 使用同一目录、数据点、采样和固定快照，返回块/run 来源与原始数值类型；绘图采样不能替代完整点证据。

复核实验时先通过 read_experiment snapshot 固定依据，再沿返回的读取提示取得 runs、metrics 与 series。快照结果提供可直接写入笔记候选的 experimentSnapshot 引用，固定曲线结果回显 snapshotId。快照保留数据水位、科研块与材料版本、解释版本及运行目录，后续追加和归档后仍可按原依据复核。服务端验证引用与项目权限。连续数据水位独立于节点版本，避免无关追加造成候选冲突。

已知运行名称时，snapshot 的 query 返回当前快照内最多三个匹配项及其固定指标目录提示。runs 的相同查询支持继续分页。创建快照时先核对节点与记录块归属。资产原件的解释版本在入库时由校验和与处理器版本共同确定，后台索引完成可以更新可用状态，同时保留已读原件的证据版本。

read_experiment events 按水位与类型读取原始富记录；大记录目录明确预览截断，使用 eventWatermark、textOffset/textLength 分段取原文。返回的附件 downloadHint 使用 transfer_asset 的 recordAttachment 目标，经同一私有交接目录和校验传输完整原件，不传大段 base64。采集凭据不会进入研究上下文，也不能绕过科研候选审批。

## 节点组接口

[组接口](../modules/node-groups/interfaces-and-changes.md) 通过 read_groups、组搜索及现有候选提供组读写；共同内容块、核心字段、neighbors 与资产块目标使用类型化对象引用。组概览不隐式展开所有成员，成员目录按范围、版本和字符预算分页。

组直接关系与成员范围对外关系必须明确区分；读取组摘要不代表读过所有成员。候选编辑使用回执 ID 和相应范围的观察版本，不要求模型构造事务、猜临时引用或为建组加载新 Skill。MCP、CLI 与 HTTP 的精确字段仍从共享合同生成。

## 文件与会话绑定

[research-mcp-binding.ts](../../../src/agent/research-mcp-binding.ts) 为运行实例绑定项目、会话凭据、文件交接根和可用 Skill 快照。transfer_asset 在工具根对象公开方向、相对路径和幂等键。已放入 out/ 的文件可直接上传，回执提供可用于候选附件的资产 ID 和校验和。下载目标位于 in/。

应用启动端口用配置文件；这里的会话环境变量是进程间凭据和绑定传递，不能混同为要求用户通过环境变量配置端口。

单次控制请求、CLI 调用和传输可以限时；Agent 整个研究回合不加应用总时限。

## Web 命令边界

工作台输入框中的 `/命令` 由会话网关按 Adapter 命令目录解析，不把整行无条件交给模型。命令与普通消息共用项目权限、回合记录、原生审批、会话队列、幂等请求、SSE 和历史；命令状态通过统一 `command.started`、`command.completed`、`command.failed` 事件保存。命令 payload 保存命令名、用户参数、执行方式、原生关联 ID 和必要的查询结果，不把凭据或原生完整配置写入历史。

当前支持 `/compact`。Codex 使用 App Server 的 `thread/compact/start`，并映射 `/review`、`/rename`、`/goal`；Claude Code 在已恢复的 `--print --input-format stream-json` 会话中发送 `/compact`；OpenCode 2 使用 V2 client 的 `session.compact`，并映射 `/undo`、`/redo`、`/fork` 及原生发现的项目命令。命令不能跳过正在运行的回合，请求入队后仍要等待原生执行结束。Skill 和项目命令可以调用普通工具，其科研写入继续受科研候选与审批约束。

供应商 TUI 的完整命令清单不是 Web 合同。主题、快捷键、登录、权限、删除、远程控制和终端进程等命令隐藏或改由 Topolumia 自有界面处理。OpenCode 2 的自定义命令必须显示来源并单独审查 Shell 模板；OpenCode 1 不新增命令发现或执行能力。命令映射和取舍见[Agent 命令决策](../decisions/004-agent-commands.md)。

验证：[protocol.test.ts](../../../tests/research/interface/protocol.test.ts)、[上下文评估脚本](../../../scripts/diagnostics/evaluate-research-context.ts)。评估使用隔离的正式科研对象，检查检索命中、梗概预算、目录不泄漏完整正文，以及内容块和来源的精确读取；报告使用字符数，不能当作 token 或真实模型质量。真实任务质量还需检查原生 Trace 和最终候选内容。
