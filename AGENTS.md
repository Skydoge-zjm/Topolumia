# Topolumia 开发入口

## 工作约定

- 项目处于探索开发阶段，替代旧方案时直接统一到新实现，无需兼容、迁移或双写；保护真实用户数据。
- 从任务相关代码开始，必要时通过 [文档导航](docs/README.md) 查业务、设计或操作方法，不要求每次先读文档。
- 正式文档与代码同仓库维护；docs/work 和 docs/references 仅保留本机，不强制添加被忽略的文件。
- 业务或机制改变时同步对应文档。小任务无需工作项；长任务的交接方式见 [维护约定](docs/playbooks/documentation.md)。
- 文档直接描述当前有效结论；变更时重写与之冲突的段落，禁止保留旧说法再追加“现已改为……”等修补说明。
- 界面标题、文案与信息密度遵循 [设计约定](DESIGN.md)。
- 开发走短期任务分支与 PR，由维护者决定合并；未明确授权时不直接推送 main 或自动合并。协作方法见 [贡献指南](CONTRIBUTING.md)。

## 开发命令

安装和启动见 [README](README.md)。以下命令均在仓库根执行：

- 类型 / lint：`npm run typecheck`、`npm run lint`。
- 前端定向测试：`npm run test:frontend -- <spec路径>`。
- 后端定向测试：`npm run build:backend` 后执行 `node --test dist/tests/<对应文件>.test.js`。
- 文档检查：`npm run docs:check`。

按改动选择验证，已通过且未受后续修改影响的检查无需重复。后端 typecheck 以 strict 检查全部 src/**/*.ts；后端构建先通过该检查，再转译源码与测试等运行产物。
