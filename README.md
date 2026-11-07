# Topolumia

本地优先的科研工作台：连接 Codex、Claude Code 和 OpenCode，通过 MCP 读写科研上下文，管理研究拓扑、实验与来源。Agent 提出的变更经人工审阅后进入正式记录。

项目处于探索开发阶段，当前主要面向本机使用，功能和数据结构仍在迭代。第一次使用可按 [入门教程](docs/playbooks/getting-started.md) 完成从空项目到研究记录的流程。

介绍页：<https://skydoge-zjm.github.io/Topolumia/>（源码在 [site/](site/)，中英双语）。

## 启动

需要 **Node.js 22.13+（22 / 24 LTS）**、npm 和 Git。

```sh
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:5510>，首次访问创建管理员账号，无预设账号密码。在「Agent 配置」中选择已安装并完成认证的 Agent CLI，设置其支持的模型；默认模型为 `gpt-6-luna`，需要相应提供商支持。Agent CLI 及模型服务需自行准备。

端口统一在 `config/topolumia.config.json` 中配置（该文件由 `config/topolumia.config.example.json` 复制而来）：后端使用 `server.port`，前端使用 `frontend.port`，前端代理地址使用 `frontend.apiUrl`。例如：

```json
{
  "server": { "host": "127.0.0.1", "port": 5510 },
  "frontend": {
    "host": "127.0.0.1",
    "port": 5610,
    "apiUrl": "http://127.0.0.1:5510"
  }
}
```

保存配置后分别运行 `npm start` 和 `npm run dev:frontend` 即可。

「Agent 配置」支持常用设置、完整配置项及原生文件编辑。各项目的 Codex `config.toml`、Claude Code `settings.json`、OpenCode `opencode.jsonc` 保存在应用数据目录中，启动时按各自方式加载；运行中的会话保留配置快照。

Agent 任务的执行时限由各自原生运行时管理，Topolumia 不额外设置整回合倒计时；长任务可以持续运行，也可在会话中主动停止。

可选配置：复制 `config/topolumia.config.example.json` 为 `config/topolumia.config.json`。默认来源配置包含合成样例；创建新项目可接入自己的研究材料。本地配置、账号、会话和研究数据不随源码分发。当前版本面向本机使用，默认仅监听 `127.0.0.1`。

「工具与环境」支持本机及 SSH 远程 Python、Conda、venv 的检测与包清单。Agent 可通过 MCP 的 `get_environment` 获取所选环境梗概，再使用自身工具探索和执行。远程检测支持 Linux、WSL 和 macOS；使用已有 SSH 别名需要服务机器安装 OpenSSH。登录凭据默认仅用于本次连接，Windows 可选加密保存。

科研拓扑包含文献、实验和研究笔记三类节点，以及可收起的嵌套节点组。研究笔记打开即可写正文，支持自由标签和多个内容块。实验节点管理多次 run；配置文件、表格行和日志可关联到具体 run。实验记录内容块支持导入 W&B、TensorBoard 原生文件及 JSON/JSONL，按指标交互展示多 run 曲线；跨实验比较为临时查看，分析可另存为研究笔记。「研究记录」追溯科研变更、Agent 提议和审批，并保存活动纪要。

读取原生 `.wandb` 或 TensorBoard event 文件时，需要单独准备读取器 Python 环境；导出的 JSON/JSONL 无需 Python。该环境与训练环境独立，不要求修改训练程序：

```powershell
python -m venv .venv-records
.venv-records/Scripts/python.exe -m pip install -r requirements/experiment-record-readers.txt
```

macOS/Linux 将上述解释器路径换为 `.venv-records/bin/python`。将 `config/topolumia.config.json` 中的 `experimentRecords.pythonCommand` 设为该解释器路径，重启后端。读取范围与限制见 [实验记录模块](docs/technical/modules/experiments-and-sources/README.md)。

## 开发

前端源码位于 `frontend/src/`，静态资源位于 `frontend/public/`，前端构建产物位于 `frontend/dist/`；根目录 `dist/` 保存后端构建产物。后端直接提供前端构建页面。

```sh
npm run dev:frontend   # 后端启动后，访问 http://127.0.0.1:5610
npm run typecheck
npm run lint
npm run test:frontend
npm test
```

文档：[任务导航](docs/README.md) · [产品](docs/product/overview.md) · [技术](docs/technical/overview.md) · [开发指南](docs/playbooks/development.md)。正式文档与代码共同维护。

`npm run release:source` 导出当前源码与正式文档到 `artifacts/github/topolumia/`，排除本地任务记录、第三方参考材料、运行数据和 Git 历史。首次公开发布可从此目录创建新仓库。

许可证：[MIT](LICENSE)。第三方依赖与标识保留各自的许可及权利声明。

## 参与项目

[贡献指南](CONTRIBUTING.md) 说明任务分支、PR 和验证约定；代码由维护者审阅并决定合并。欢迎提交 [Bug 报告](https://github.com/Skydoge-zjm/Topolumia/issues/new?template=bug_report.yml) 和 [功能建议](https://github.com/Skydoge-zjm/Topolumia/issues/new?template=feature_request.yml)。疑似漏洞按 [安全报告说明](SECURITY.md) 私下报告。
