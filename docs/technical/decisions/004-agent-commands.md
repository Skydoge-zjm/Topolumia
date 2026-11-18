# Agent 命令边界

## 决策

Topolumia 为 Agent 会话提供经过筛选的 Web 命令目录。命令由会话网关解析并排队，Adapter 使用各自原生协议执行；未知或仅属于终端界面的命令不作为普通提示词发送。

首个统一命令是 `/compact`：Codex 使用 App Server `thread/compact/start`，Claude Code 使用已恢复非交互会话中的 `/compact`，OpenCode 2 使用 `session.compact`。第一阶段还映射 Codex 的 `/review`、`/rename`、`/goal`，OpenCode 2 的 `/undo`、`/redo`、`/fork` 和项目命令。每个命令具有普通回合记录，并关联原生执行身份；只有执行结束或失败后才结束命令并推进队列。审批、取消、恢复和幂等提交使用统一回合机制。

## 原因

三种 Agent 的斜杠命令表同时包含会话操作、终端 UI、账号设置、Skill 和自定义 Prompt。它们的执行语义不同：Codex App Server 有独立 RPC，OpenCode 2 有专用 session API，Claude Code 的部分命令只在 `-p` 模式可用。把所有文本直接交给 Agent 会让 Codex 的命令变成普通 turn，让 OpenCode 的专用命令进入错误 endpoint，也会让 Claude 的未知命令意外消耗模型回合。

命令必须与普通消息共用会话队列和历史，才能避免压缩、停止和恢复之间的竞态。命令还需要保留名称和参数，便于用户理解实际发生的操作，并避免把原生协议细节散落到前端。

## 边界

- Web 菜单只显示 Adapter 声明为可执行的命令；供应商完整 TUI 清单不是产品承诺。
- 权限、账号、远程控制、终端设置和破坏性操作不通过普通命令菜单执行。
- OpenCode 2 自定义命令可能含有绕过 Agent 工具权限的 Shell 模板，必须显示来源并单独审查。
- OpenCode 1 仅维持已有会话能力，不实现新的命令发现或执行。

精确命令字段以 `src/domain/agents/agent-commands.ts` 为准，回合合同以 `src/domain/agents/agent-types.ts` 为准，原生协议以各 Adapter 和供应商版本为准。
