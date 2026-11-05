# Topolumia

本地优先的科研工作台：连接 Codex、Claude Code 和 OpenCode，通过 MCP 读写科研上下文，管理研究拓扑、实验与来源。Agent 提出的变更经人工审阅后进入正式记录。

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

科研拓扑支持多类科研对象、自由内容块和可收起的嵌套节点组。文献节点提供书目信息及图表、文件等阅读成果；其他类型目前主要采用通用核心。实验详情可展示关联运行的指标、曲线和外部链接。「研究记录」追溯科研对象变更、Agent 提议和审批，并保存组会、阅读、复盘及周期活动纪要。

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
