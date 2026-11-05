# 参与 Topolumia

欢迎报告问题、改进文档、补充测试和提交代码。项目处于探索开发阶段，较大的功能、依赖引入或数据机制调整，请先用 [功能建议](https://github.com/Skydoge-zjm/Topolumia/issues/new?template=feature_request.yml) 说明使用场景和范围，再开始实现。

第一次使用请看 [入门教程](docs/playbooks/getting-started.md)；开发环境与启动方式见 [开发指南](docs/playbooks/development.md)。问题反馈可以使用中文或英文。

## 问题反馈

提交前搜索已有 issue，尽量用空项目和合成材料复现。Bug 报告请提供提交号、系统、Node.js 版本、复现步骤、预期与实际结果；涉及 Agent 时补充 CLI 名称、版本和是否完成认证。

日志、截图和附件中请移除令牌、密码、账号会话、主机地址和未公开研究材料。不要上传整个 runtime 或工作目录。疑似越权、凭据泄露、路径穿越等安全问题，按 [安全报告说明](SECURITY.md) 私下报告。

## 分支与合并

`main` 保持可构建、测试通过。维护者、协作者和 Agent 的日常修改都在短期任务分支完成，一个分支处理一个明确问题，例如 `feat/paper-sources`、`fix/ssh-auth` 或 `docs/first-project`。不需要长期 develop 分支。

有仓库写权限时，从最新 main 开始：

```sh
git switch main
git pull --ff-only
git switch -c fix/short-description
```

没有写权限时，先在 GitHub fork 仓库，再从 fork 创建分支；PR 的目标选择 `Skydoge-zjm/Topolumia` 的 `main`。保持提交范围清晰，不把无关格式化、生成产物或本机配置混进 PR。

推送任务分支后提交 PR；尚未完成的工作使用 Draft。PR 说明修改原因、用户可见行为、验证结果和已知限制。界面修改附截图，功能或机制改变同步对应文档。

CI 通过后，由维护者 [@Skydoge-zjm](https://github.com/Skydoge-zjm) 审阅并决定是否合并。默认使用 Squash merge，合并后删除任务分支。协作者和 Agent 不自行合并，也不直接推送 main；维护者明确要求的例外按当次授权执行。AI 辅助生成的代码同样由提交者负责核查和验证。

## 实现与验证

- 按 [AGENTS.md](AGENTS.md) 的工程约定开发；界面改动遵循 [DESIGN.md](DESIGN.md)。
- 保护真实研究数据。替换实现时直接统一到当前方案，不增加无必要的兼容、迁移或双写逻辑。
- 按 [测试指南](docs/playbooks/testing.md) 选择受影响的验证，PR 如实记录执行的命令、结果以及未验证的外部条件。
- 文档和源码示例不要依赖作者本机路径、忽略目录或真实科研材料；文档维护方法见 [文档维护](docs/playbooks/documentation.md)。

本地可执行的常用检查：

```sh
npm run typecheck
npm run lint
npm run docs:check
```

根据改动再运行定向测试。CI 会运行前端测试、前后端构建和后端回归；真实模型、科研 Python、SSH 主机及外部实验服务按相关任务单独验证。请勿为了让检查通过而关闭失败测试或修改真实项目数据。

## 许可

提交贡献表示你有权提供相应代码、文字和资源，并同意以项目的 [MIT 许可证](LICENSE) 分发。引入第三方内容时保留来源和必要的许可声明，不上传没有再分发权限的论文全文、图表或数据集。
