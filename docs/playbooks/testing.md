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
| 笔记与实验 run、材料关联 | [实验记录](../../tests/research/experiment-records.test.ts)、[Schema 预算](../../tests/research/interface/schema-output.test.ts)、[笔记与多 run 浏览器流程](../../frontend/e2e/experiment-records.spec.ts) |
| 多 run 曲线交互 | [ExperimentPlots.spec.tsx](../../frontend/src/features/experiments/ExperimentPlots.spec.tsx)，涉及布局再检查上述浏览器流程的桌面和手机截图 |
| 环境梗概 | [research-environment-context](../../tests/environments/research-environment-context.test.ts)，不默认探测所有真实环境 |
| 发布筛选 | `npm run test:release`；需要真实导出再运行 `npm run release:source` |

## 浏览器与真实集成

[Playwright 配置](../../frontend/playwright.config.ts) 不会自动启动统一 webServer。许多新用例在临时目录创建自己的服务；其他用例使用配置中的 baseURL。运行前读对应文件的准备部分，不能把默认 4184 当成用户服务端口。

真实模型、SSH、TeX 编译、Python 与实验 provider 测试有外部条件，按需运行并记录跳过或不可用。真实模型任务的质量要检查候选正文、图表证据和失败重试，不能仅看 HTTP 200 或候选数量。

实验集成单独使用 package.json 中 setup:experiment-test-env 与 test:experiment-integration；其依赖及真实端点不是普通回归测试前提。

归档原生文件的集成测试使用 [官方写入器生成的离线合成记录](../../scripts/testing/generate-native-records.py)，不访问 W&B 账号或训练服务。先在专用 Python 环境安装 `requirements/experiment-record-readers.txt`，然后执行：

```powershell
$env:TOPOLUMIA_RECORD_TEST_PYTHON = (Resolve-Path .venv-records/Scripts/python.exe).Path
npm run test:experiment-records-integration
```

[原生记录集成](../../tests/research/experiment-records.integration.ts) 覆盖失败且无指标的 run、W&B 分片记录、TensorBoard 标量、原件保留以及丢失派生索引后的重建。此项需要可用的读取器依赖，不计入无需 Python 的普通后端回归。

## 实验大数据性能

[诊断脚本](../../scripts/diagnostics/benchmark-experiment-performance.mjs) 在临时目录和内存数据库生成合成记录，测量 60 run × 2000 step × 4 指标的导入、绘图、单列与批量范围读取，以及 15 万点长曲线和不同步长的前端数组构建。先完成后端构建，在没有其他构建或测试竞争资源时执行：

```powershell
node scripts/diagnostics/benchmark-experiment-performance.mjs runtime/experiment-performance.json
```

同时看总耗时与主事件循环延迟；后台线程首次启动可能增加导入总耗时，不能只据此判断交互响应。缓存热读与冷线程分别测量，不能混为同一基线。缓存计费体积与数组槽数也不等于实际堆内存。脚本仅清理自己创建的临时目录，不读取真实实验。

浏览器验证使用 [大数据用例](../../frontend/e2e/experiment-performance.spec.ts)，构建完成后执行 `npm run test:e2e -- experiment-performance.spec.ts`。它自建隔离服务，记录打开耗时和浏览器长任务，并断言画布生命周期、真实曲线路径、缩放恢复、请求数量、虚拟行及完整分页复制。时间记录用于同机复测，不使用容易受机器负载影响的固定毫秒阈值代替正确性检查。

## GitHub Actions

[CI](../../.github/workflows/ci.yml) 在 main 推送和拉取请求时只运行一套 Ubuntu / Node.js 22 检查：安装、文档链接、类型、lint、前端测试、构建与后端回归。同一分支、同一环境的新提交会取消旧任务，避免重复消耗 runner。

开发阶段不自动展开操作系统与 Node.js 版本矩阵。需要兼容性验证时，在 Actions 的 Run workflow 中选择 Windows 或 Node.js 24，仍然每次只运行所选的一套环境。发布前勾选 source release and dependency audit，额外检查文档检查器、源码导出边界、导出目录文档及高危依赖公告。

后端回归里的 SSH 使用本机临时服务和合成密钥，原生 Agent 使用协议 fixture；这些测试不需要真实模型账号或远程科研服务器。测试路径应按实际文件系统解析，关闭拥有的数据库与异步资源后才能删除临时目录。

## 结果表述

区分类型检查、构建、逻辑测试、浏览器行为与真实科研质量。后端 [转译配置](../../tsconfig.backend.json) 启用 noCheck；[检查配置](../../tsconfig.backend.check.json) 只覆盖指定关键边界，不宣称完整 strict。

通过的定向检查无需无理由反复运行。验证记录写范围与结果，不把过往通过数固化进长期文档；截图和日志放临时输出位置，完成审阅后清理。
