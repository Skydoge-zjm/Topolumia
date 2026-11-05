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

公开 Schema 可辅助完整编辑；网络不可用时要明确诊断，已有有效配置不应被清空。凭据与完整原文配置不写进日志、任务记录或公开示例。

## 验证

[native-config.test.ts](../../../../tests/agents/configuration/native-config.test.ts)、[agent-configuration.test.ts](../../../../tests/agents/configuration/agent-configuration.test.ts) 检查解析、保存与快照；[NativeAgentConfigEditor.spec.tsx](../../../../frontend/src/features/agents/configuration/NativeAgentConfigEditor.spec.tsx)、[agent-native-config.spec.ts](../../../../frontend/e2e/agent-native-config.spec.ts) 检查界面往返。
