# 科研 MCP 的原生 Agent 对照评测

评测通过 Codex App Server、Claude Code stream-json 和 OpenCode 2 HTTP/SSE 驱动真实客户端。每个客户端分别在两个全新的本机项目中执行固定任务，使用同一个 `gpt-6-luna` 模型。每个项目拥有独立的数据库、账号、Agent 凭据、文件交接目录和原生会话。用例、合成材料与评分函数在[评测脚本](../../scripts/diagnostics/mcp-agents/cases.mjs)中。

| 用例 | 交付与证据 |
| --- | --- |
| 科研交接 | 从组成员找到基线，从有向关系确定交付对象，读取组块与版本化原文。上传已暂存的文件，核对校验和，在同一待审笔记上增量补充局限性。 |
| 实验复核 | 确认环境，在同一冻结快照上读取两次运行的精确曲线，核算指定步骤的差值。保存带依据的指标块，说明单次运行的推断局限，回读候选块。 |

[留出的论文归档用例](../../scripts/diagnostics/mcp-agents/paper-case.mjs)单独使用 `paper` 参数运行。它从已登记的原稿提取书目、数值表和证据局限，检查候选附件、精确资产回执，以及下载到交接目录的实际文件摘要。

## 运行

先运行 `npm run build:backend`。选择安装好的 Codex、Claude Code 和项目支持的 OpenCode 2 可执行文件。评测使用现有模型网关。向启动评测的进程提供以下设置。

| 环境变量 | 值 |
| --- | --- |
| `TOPOLUMIA_EVAL_OPENAI_URL`、`TOPOLUMIA_EVAL_OPENAI_KEY` | 提供 Responses 和 Chat Completions 的同一网关 API 根地址与凭据。根地址应包含网关要求的路径前缀，如 `/v1`。 |
| `TOPOLUMIA_EVAL_ANTHROPIC_URL`、`TOPOLUMIA_EVAL_ANTHROPIC_KEY` | 在 Messages 协议下提供同一模型的 API 根地址与凭据。评测器在根地址后追加 `/messages`。 |
| `TOPOLUMIA_EVAL_CODEX_BIN`、`TOPOLUMIA_EVAL_CLAUDE_BIN`、`TOPOLUMIA_EVAL_OPENCODE2_BIN` | 可选，指定原生可执行文件。默认从 PATH 查找 `codex`、`claude`、`opencode2`。 |
| `TOPOLUMIA_EVAL_CODEX_CATALOG` | 可选，安装的 Codex 需要自定义模型目录时，提供目录文件路径。 |
| `TOPOLUMIA_EVAL_BUILD`、`TOPOLUMIA_EVAL_REVISION` | 可选，分别指向已冻结的 `dist` 目录和对应的源码修订标识。 |

```sh
node scripts/diagnostics/mcp-agents/run.mjs artifacts/mcp-evaluation/round-00
node scripts/diagnostics/mcp-agents/summarize.mjs artifacts/mcp-evaluation
```

第一个命令为本轮创建新目录。可追加两个参数选择客户端和任务，如 `claude dossier`、`opencode2 curves` 或 `all probe`。探针只验证链路。默认每一轮执行六个独立会话。每项评测的研究回合设十分钟时限。结果、MCP 调用和网关计量保存在本机，外部推理服务接收原生客户端发出的合成任务上下文。

## 读数

- 每个任务有 12 个二元验收点。计分依据包括待审候选、正式科研状态、固定快照、证据回执、成功的 MCP 调用和助手交付文本。完整完成还要求原生回合正常结束并通过模型核验。
- 分别保存网关返回的输入、缓存输入、输出 token 和客户端原生用量。总 token 包含缓存输入。单位得分消耗按同一批任务的总 token 除以总得分计算，零分任务的消耗也计入分子。若有响应在流结束前中断而缺少用量，总量留空，同时保留已计量请求的下界。补测使用全新目录，原始中断记录保留。
- MCP 失败按 stdio 调用的实际错误结果计数，包含进入 CLI 前的校验失败。原生非 MCP 工具失败与网关请求失败另记。候选内容漏项通过验收点体现。版本目录中保留任务中断和部分完成的数据。
- 每轮的 `manifest.json` 保存提示词、产品版本、工具目录与散列。每项任务有一份结果 JSON 和一份逐调用 JSONL。汇总器按当前同一套评分函数重算所有轮次，生成 `metrics.csv` 和 `metrics.json`。配对比较时使用相同任务、客户端、模型和权限设置，结合完整交付数及每分 token 判断变化。
