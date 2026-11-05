# 安全报告

Topolumia 目前处于探索开发阶段，主要面向本机使用。安全修复以 main 上的最新代码为目标；尚不维护旧版本的长期安全回补。报告问题时请提供提交号或版本，必要时在最新代码上用合成数据确认复现。

## 私下报告

疑似安全漏洞请发送至维护者邮箱 [jmzhangskydoge@gmail.com](mailto:jmzhangskydoge@gmail.com)，主题使用 `Topolumia security report`。如果仓库 [Security 页面](https://github.com/Skydoge-zjm/Topolumia/security) 提供 **Report a vulnerability**，也可以通过该入口提交 GitHub 私密报告。

请勿在公开 issue、PR、评论或附件中发布可利用的漏洞细节或真实凭据。一般使用问题和未涉及安全边界的 Bug 可以使用 [问题模板](https://github.com/Skydoge-zjm/Topolumia/issues/new?template=bug_report.yml)。

报告建议包含：

- 受影响的提交或版本、操作系统、Node.js 及相关 Agent CLI 版本。
- 所需身份和权限、涉及的功能，以及影响范围。
- 在隔离环境中的最小复现步骤、预期边界与实际结果。
- 使用合成账号和文件的请求或概念验证；日志中的令牌、Cookie、密码和研究内容应脱敏。
- 如已找到原因，可附修复思路。

维护者会核查影响、确认修复并与你协调公开说明。项目由个人维护，不承诺固定响应或修复时限；如未收到回复，可以在同一私密渠道补充信息。

## 运行边界

- 默认只监听 `127.0.0.1`，当前验证范围是本机运行。账号与项目权限已有实现，完整互联网托管部署、TLS 和远程 MCP 服务不属于当前交付能力。
- Agent 原生终端、文件操作和模型服务各有自己的执行与数据传输边界。科研候选审批负责是否将内容写入正式研究对象，不能替代原生工具的执行授权。
- `.gitignore` 不会加密数据。runtime、项目数据库、SSH 凭据和本机配置应留在受控机器中；需要备份时按 [运行维护](docs/playbooks/operations.md) 操作。

越权读取或审批、跨项目访问、文件路径穿越、凭据或会话泄露，以及未获授权的命令执行，都属于适合私下报告的问题。权限实现见 [权限边界](docs/technical/architecture/authorization.md)，存储范围见 [数据与存储](docs/technical/architecture/data-and-storage.md)。

请只在你拥有或得到授权的环境中验证。若真实密钥已泄露，先在对应提供商撤销或轮换，再报告；不要在报告里发送仍然有效的密钥。
