# 三种 Agent 的项目原生配置

需求：[工作台需求](../../../product/requirements/agent-workbench.md)。配置属于应用项目数据，不能为设置 Topolumia 而直接改写用户主目录的全局 Agent 配置。

## 文件与界面

[NativeAgentConfigStore](../../../../src/services/agents/configuration/native-config-store.ts) 在项目 agent-config 根内保存各供应商原生文件；[native-format](../../../../src/services/agents/configuration/native-format.ts) 是文件名、格式、初始数据与解析规则的权威来源。

Codex 为 config.toml，Claude Code 为 settings.json，OpenCode 为 opencode.jsonc。保存校验并原子替换，防止路径符号链接和失效内容；创建会话取得配置快照，运行会话不因后续编辑被静默改写。

前端 [NativeAgentConfigEditor](../../../../frontend/src/features/agents/configuration/NativeAgentConfigEditor.tsx) 提供常用字段和原文编辑。两种编辑方式维护同一配置；不能用常用表单重建文件而丢掉高级字段。

## 启动映射

| Agent | 当前实现 |
| --- | --- |
| Codex | 解析 TOML 并传给 app-server 配置及 thread 启动；通过配置参数与应用必要覆盖合并，不假设存在通用的配置文件路径参数 |
| Claude Code | 使用 --settings 指向快照；会话授权产生合并后的会话设置文件 |
| OpenCode | 向本地 server 传 OPENCODE_CONFIG 及合并的 OPENCODE_CONFIG_CONTENT，应用必需的 MCP 绑定单独合入 |

精确优先级以 [Codex driver](../../../../src/adapters/agents/codex/codex-app-server-driver.ts)、[Claude driver](../../../../src/adapters/agents/claude/claude-cli-stream-driver.ts)、[OpenCode server](../../../../src/adapters/agents/opencode/opencode-server.ts) 为准。主机版本支持不同，不应宣称三种 CLI 的参数完全一致。

## MCP 工具加载

Codex 的 Topolumia 绑定默认使用 `omit_tools_from = ["direct"]`，保留按需工具搜索范围，并将普通工具输入 Schema 压缩阈值设为 5000 UTF-8 字节。项目原生配置中该服务器的 `omit_tools_from`、`tool_input_schema_max_bytes`、`enabled_tools` 与 `disabled_tools` 显式值仍生效；传输地址、命令与会话凭据由应用绑定。当前配置使用宿主支持的工具表面设置，不写入已移除的 `features.tool_search` 开关。

Claude Code 的科研 MCP 绑定不覆盖 `ENABLE_TOOL_SEARCH`，沿用原生设置和所选模型、提供商的加载能力。用户通过原生配置或运行环境设置的 `true`、`auto` 或 `false` 保持原意；宿主可能因模型或网关不支持而回退为提前加载。

按需加载控制初始披露；Agent 若搜索并输出整个工具目录，完整声明仍会进入后续上下文。统计时分别记录初始定义和后续发现的声明，不能只根据启用开关判断整段会话的开销。

工具目录的 JSON 字符数、原生会话文件大小和模型输入 token 数分别统计。原生会话 JSON/JSONL 可能只保存工具搜索引用和用量，不保存完整请求 Schema；缺少定义的记录不能用来推算精确的工具 token 占比。需要测量定义比例时，使用独立合成会话并记录模型请求的定义结构与对应会话身份，明确字符或 token 的统计口径。

公开 Schema 可辅助完整编辑；网络不可用时要明确诊断，已有有效配置不应被清空。凭据与完整原文配置不写进日志、任务记录或公开示例。

## 验证

[native-config.test.ts](../../../../tests/agents/configuration/native-config.test.ts)、[agent-configuration.test.ts](../../../../tests/agents/configuration/agent-configuration.test.ts) 检查解析、保存与快照；[NativeAgentConfigEditor.spec.tsx](../../../../frontend/src/features/agents/configuration/NativeAgentConfigEditor.spec.tsx)、[agent-native-config.spec.ts](../../../../frontend/e2e/agent-native-config.spec.ts) 检查界面往返。
