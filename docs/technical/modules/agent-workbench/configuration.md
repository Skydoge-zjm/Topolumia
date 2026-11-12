# 三种 Agent 的项目原生配置

需求：[工作台需求](../../../product/requirements/agent-workbench.md)。配置属于应用项目数据，不能为设置 Topolumia 而直接改写用户主目录的全局 Agent 配置。

## 文件与界面

[NativeAgentConfigStore](../../../../src/services/agents/configuration/native-config-store.ts) 在项目 agent-config 根内保存各供应商原生文件；[native-format](../../../../src/services/agents/configuration/native-format.ts) 是文件名、格式、初始数据与解析规则的权威来源。

Codex 为 config.toml，Claude Code 为 settings.json，OpenCode 两版均为 opencode.jsonc。V1 保留 agent-config/opencode 目录，V2 使用独立的 agent-config/opencode-v2；配置缓存、Schema 和快照按配置身份隔离，Provider 品牌身份保持 opencode。保存校验并原子替换，防止路径符号链接和失效内容；创建会话取得配置快照，运行会话不因后续编辑被静默改写。

前端 [NativeAgentConfigEditor](../../../../frontend/src/features/agents/configuration/NativeAgentConfigEditor.tsx) 提供常用字段和原文编辑。两种编辑方式维护同一配置；不能用常用表单重建文件而丢掉高级字段。

## 启动映射

| Agent | 当前实现 |
| --- | --- |
| Codex | 解析 TOML 并传给 app-server 配置及 thread 启动；通过配置参数与应用必要覆盖合并，不假设存在通用的配置文件路径参数 |
| Claude Code | 使用 --settings 指向快照；会话授权产生合并后的会话设置文件 |
| OpenCode 1 | 使用冻结的 V1 SDK 和 server，保留既有配置与 MCP 注入行为 |
| OpenCode 2 | 独立 server 使用 OPENCODE_PASSWORD；传入配置快照与 OPENCODE_CONFIG_CONTENT，原生数据库通过 OPENCODE_DB 指向应用的独立 opencode-v2 数据目录 |

精确优先级以 [Codex driver](../../../../src/adapters/agents/codex/codex-app-server-driver.ts)、[Claude driver](../../../../src/adapters/agents/claude/claude-cli-stream-driver.ts)、[OpenCode V1 server](../../../../src/adapters/agents/opencode/v1/opencode-server.ts)、[OpenCode V2 server](../../../../src/adapters/agents/opencode/v2/opencode-server.ts) 为准。主机版本支持不同，不应宣称三种 CLI 的参数完全一致。

## OpenCode 版本与权限

OpenCode 1 的 Profile ID 保留 opencode-acp，旧驱动名 opencode-server 明确映射 V1。OpenCode 2 使用 opencode-v2 Profile 和 opencode-server-v2 驱动，支持 2.2.7 至 2.x。两版分别检查最低版本及主版本；未知、不匹配或未来主版本不会自动切换驱动。需要同时使用时，在应用配置中为两版指定各自的 CLI 可执行文件。

V2 常用表单修改权限默认项时保留原 permissions 数组中的有序例外；完整原文及高级 Provider 字段往返保存。默认配置询问外部目录访问。原生 always 回复保存为项目级规则，显示“允许并保存到项目”，使用 persistent 审批范围并校验应用的高风险审批权限。

## MCP 工具加载

Codex 的 Topolumia 绑定默认使用 `omit_tools_from = ["direct"]`，保留按需工具搜索范围，并将普通工具输入 Schema 压缩阈值设为 5000 UTF-8 字节。项目原生配置中该服务器的 `omit_tools_from`、`tool_input_schema_max_bytes`、`enabled_tools` 与 `disabled_tools` 显式值仍生效；传输地址、命令与会话凭据由应用绑定。当前配置使用宿主支持的工具表面设置，不写入已移除的 `features.tool_search` 开关。

Claude Code 的科研 MCP 绑定不覆盖 `ENABLE_TOOL_SEARCH`，沿用原生设置和所选模型、提供商的加载能力。用户通过原生配置或运行环境设置的 `true`、`auto` 或 `false` 保持原意；宿主可能因模型或网关不支持而回退为提前加载。

OpenCode 2 的科研 MCP 绑定通过 V2 动态 API 注册和连接，验证 connected 状态后才创建可用会话。该绑定使用运行实例的独立凭据，禁用跨会话连接池；科研工具直接披露，普通用户原生配置中的其他 MCP 设置继续由 CLI 加载。科研指导使用会话指令条目的固定键注入，恢复时替换原运行实例的指导，不额外发送模型回合。

按需加载控制初始披露；Agent 若搜索并输出整个工具目录，完整声明仍会进入后续上下文。统计时分别记录初始定义和后续发现的声明，不能只根据启用开关判断整段会话的开销。

工具目录的 JSON 字符数、原生会话文件大小和模型输入 token 数分别统计。原生会话 JSON/JSONL 可能只保存工具搜索引用和用量，不保存完整请求 Schema；缺少定义的记录不能用来推算精确的工具 token 占比。需要测量定义比例时，使用独立合成会话并记录模型请求的定义结构与对应会话身份，明确字符或 token 的统计口径。

公开 Schema 可辅助完整编辑；网络不可用时要明确诊断，已有有效配置不应被清空。凭据与完整原文配置不写进日志、任务记录或公开示例。

## 验证

[native-config.test.ts](../../../../tests/agents/configuration/native-config.test.ts)、[agent-configuration.test.ts](../../../../tests/agents/configuration/agent-configuration.test.ts) 检查解析、保存与快照；[NativeAgentConfigEditor.spec.tsx](../../../../frontend/src/features/agents/configuration/NativeAgentConfigEditor.spec.tsx)、[agent-native-config.spec.ts](../../../../frontend/e2e/agent-native-config.spec.ts) 检查界面往返。
