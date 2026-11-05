# 按改动范围选择验证

验证目标是证明受影响的行为与边界。选择最小充分集合；发现失败或新风险后再扩大，不机械重复全套测试。

## 常用命令

从源码根执行，使用根 package.json；frontend 没有独立 package.json。

```powershell
# 编辑器等前端逻辑
npm run test:frontend -- frontend/src/features/topology/details/ContentBlockEditor.spec.tsx

# 后端先转译，再只运行相关文件
npm run build:backend
node --test dist/tests/research/object-consistency.test.js

# 类型和 lint；后端覆盖范围见下面说明
npm run typecheck
npm run lint

# 浏览器用例前需有当前后端和前端产物
npm run build
npm run test:e2e -- research-edit-integrity.spec.ts

# 文档任务
npm run docs:check
```

上述是选择示例，不要求每次顺序执行全部命令。npm test 会重新构建并运行全部后端测试；定向调试不必反复用它。

## 风险与入口

| 改动 | 优先验证 |
| --- | --- |
| 纯文案、间距、图标 | 对应页面浏览器检查，必要时构建；无需新建重复逻辑测试 |
| 编辑、序列化、payload | 往返编辑与未修改字段保留；[编辑器测试](../../frontend/src/features/topology/details/ContentBlockEditor.spec.tsx) |
| 科研提交、关系、删除 | [对象一致性](../../tests/research/object-consistency.test.ts)、[接口合同](../../tests/research/interface/protocol.test.ts) |
| 权限、审批、撤权 | [审批边界](../../tests/agents/sessions/approval-authority.test.ts)、[可靠性](../../tests/agents/sessions/reliability.test.ts) |
| 原生事件或恢复 | 对应 provider 测试，加 [统一 Trace](../../tests/agents/protocol/native-trace-alignment.test.ts) 或 [前端合并](../../frontend/src/features/agents/conversation/model/agentSession.spec.ts) |
| 历史保存、图片 | [历史存储](../../tests/agents/sessions/history-store.test.ts)、可靠性中的检查点与媒体场景 |
| 表格解析、文件处理 | [导入器](../../tests/research/table-importers.test.ts)，涉及显示再跑 [真实文件浏览器用例](../../frontend/e2e/research-table-import.spec.ts) |
| 环境梗概 | [research-environment-context](../../tests/environments/research-environment-context.test.ts)，不默认探测所有真实环境 |
| 发布筛选 | `npm run test:release`；需要真实导出再运行 `npm run release:source` |

## 浏览器与真实集成

[Playwright 配置](../../frontend/playwright.config.ts) 不会自动启动统一 webServer。许多新用例在临时目录创建自己的服务；其他用例使用配置中的 baseURL。运行前读对应文件的准备部分，不能把默认 4184 当成用户服务端口。

真实模型、SSH、TeX 编译、Python 与实验 provider 测试有外部条件，按需运行并记录跳过或不可用。真实模型任务的质量要检查候选正文、图表证据和失败重试，不能仅看 HTTP 200 或候选数量。

实验集成单独使用 package.json 中 setup:experiment-test-env 与 test:experiment-integration；其依赖及真实端点不是普通回归测试前提。

## 结果表述

区分类型检查、构建、逻辑测试、浏览器行为与真实科研质量。后端 [转译配置](../../tsconfig.backend.json) 启用 noCheck；[检查配置](../../tsconfig.backend.check.json) 只覆盖指定关键边界，不宣称完整 strict。

通过的定向检查无需无理由反复运行。验证记录写范围与结果，不把过往通过数固化进长期文档；截图和日志放临时输出位置，完成审阅后清理。
