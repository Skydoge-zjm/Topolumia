# 实验记录与来源

业务边界见 [科研模型](../../../product/business/research-model.md)，验收见 [工作区需求](../../../product/requirements/research-workspace.md)。实验节点记录可复现的结果单位，可含失败、重试和复现的多个 run。平台读取、归档和呈现已有材料，不增加训练 SDK 或启动器。

## 实验对象与共同写入

[experiment-records.ts](../../../../src/domain/research/experiment-records.ts) 定义统一 run、材料关联和过程记录 payload。实验节点持有 run 清单、materialLinks 和 experimentRevision；`experimentRecord` 块引用这些 run，保存提供商、来源身份与原始资产 ID，不内嵌曲线数组。

[experiment-mutations](../../../../src/services/research/changes/experiment-mutations.ts) 通过 `editExperiment` 接入共同模拟、提交、对象版本、历史和候选。人工入口携带观察版本；Agent 通过 nodeChanges.experimentPatch 提议并由人审阅，不直接修改正式实验。

run 标签不要求唯一，来源身份用于重复导入的识别；用户也可在导入时选择已有 run。没有来源 ID 的文件按资产身份区分，不能仅因指标字节相同而合并独立执行。失败且尚无指标的有效 run 仍保留，不补造零值。

## 原始记录与索引

[ExperimentRecordImporter](../../../../src/services/research/experiments/record-importer.ts) 读取上传的 `.wandb`、TensorBoard event 和 JSON/JSONL 标量记录。原件沿用 [资产生命周期](../content-blocks/file-lifecycle.md) 归档；派生数值索引按资产校验值保存，并可从原件重建。原件改变或索引失配会报告错误，不能用当前项目文件替代归档。

[Python 读取器](../../../../scripts/runtime/experiment-record-parser.py) 使用 W&B protobuf 与 TensorBoard EventAccumulator。W&B 容器读取采用保留上游 MIT 声明的 [只读封装](../../../../scripts/runtime/wandb_record_reader.py)。读取器由 `experimentRecords.pythonCommand` 指定，默认 python，与项目训练解释器独立；可选依赖见 [experiment-record-readers.txt](../../../../requirements/experiment-record-readers.txt)。JSON/JSONL 读取不依赖 Python。

当前范围是有限数值标量及其 step / epoch / 时间来源；不统一解析第三方图片、直方图、音频或自定义面板。上传是快照，不持续监视用户项目中的增长文件。配置、代码、命令和终端日志用普通内容块归档，最终指标继续用 metric、table、XLSX、TeX/PDF 等内容能力表达。

## 材料与运行对应

[ExperimentRecordService](../../../../src/services/research/experiments/record-service.ts) 按块版本和具体材料项保存关联：整块、文件、内联数据行、上传表格的工作表与物理行。内联 rowIndex 从数据首行计数，不含表头；assetRow 从原文件首行计数，包含表头。前端均以从 1 开始的行号操作，并显示所选数据。

文件行关联以归档文件校验值、工作表与实际行数校验；人工提交前读取实际范围，Agent 则必须先通过 read_assets values 取得该范围的证据。候选可以增量关联自己已提议的 run 和材料。读取回执仅覆盖实际交付的 run、关联或表格范围，不能用目录摘要授权未读对象的修改。

后续块编辑不改变已关联版本；详情、候选和历史通过同一只读呈现查看当时文件或行。材料之间的对应是实验内部关系，科研对象之间的逻辑仍由拓扑有向边表达。

## 查看、比较与 Agent 读取

[实验路由](../../../../src/http/routes/research/experiment-records.ts) 提供运行维护、只读数据与绘图接口。`read_experiment` 经共同 MCP / CLI / HTTP 合同提供 runs、materials、metrics、series、inspect 与 compare。通常先读取 run 目录，再读取指标目录，最后按范围读取准确数据点；材料返回可调用的 read_blocks / read_assets 提示。精确合同以 [tools.ts](../../../../src/domain/research/interfaces/tools.ts) 为准。

[ExperimentWorkbench](../../../../frontend/src/features/experiments/ExperimentWorkbench.tsx) 把实验详情组织为常驻的运行栏与研究材料：选中 run 时曲线按所选运行过滤，材料关联就地展开，不再需要先切换到另一个标签页记住内容块标题。运行栏支持重命名、改状态与删除；删除前说明指向该 run 的材料关联数，记录块仍在引用时拒绝删除并指出需先处理的内容块。

[ExperimentPlots](../../../../frontend/src/features/experiments/ExperimentPlots.tsx) 基于 uPlot 画布按指标绘制多 run 交互曲线，支持图例开关、框选缩放、键盘操作和精确点分页。曲线颜色由 run 身份哈希决定，同一 run 在内容块与对比窗口中保持一致；刻度使用 1/2/5 × 10ⁿ 步长。绘图受总点数预算控制，采样明确标注；精确读取与显示采样分开。部分来源不可用时合并为一个可展开警告并保留其他可用曲线，权限错误仍拒绝读取。画布不可用时（如测试环境）退化为数据点表格，图例与读取入口不变。

[ExperimentCompareDialog](../../../../frontend/src/features/experiments/ExperimentCompareDialog.tsx) 允许从不同实验选择 run，只叠加完全同名的指标；选择列表带状态与来源，到 24 条上限时说明原因。人和 Agent 的比较均为临时读取，不创建比较对象、内容块或候选。分析需要另建研究笔记，Agent 写入沿用审批。

## 服务来源与刷新

[AdapterRegistry](../../../../src/services/platform/adapter-registry.ts) 装配 Git、文件系统、MLflow、W&B、TensorBoard 与执行适配器。[ExperimentTrackingGateway](../../../../src/services/experiments/experiment-tracking-gateway.ts) 管服务运行列表、指标、系列、缓存与读取限额。实验记录块可选择已接入的服务 run；服务值随来源变化，也可能已被提供商采样，不视为归档原文件中的完整历史。

TensorBoard、W&B 安装版本是环境事实，追踪源是连接，实际 run 是执行身份；环境选择不会自动让追踪服务读取远端任意日志。`/api/research-experiments` 只列正式保存的实验和 run；合成样例只用于明确的来源夹具，不作为节点结果兜底。

[SourceRefreshCoordinator](../../../../src/services/platform/source-refresh-coordinator.ts) 管新鲜度、后台检查和合并请求。活跃研究操作或 Agent 工作可推迟刷新，来源刷新不能覆盖已保存的科研对象。文件来源排除应用数据、transfer 与 Skill 快照；资产通过领域接口读取，不扫描 runtime 发现材料。状态哈希排除纯时间戳噪声。

## 验证

- [experiment-records.test.ts](../../../../tests/research/experiment-records.test.ts)：统一 run、候选与观察范围、材料历史、上传表格行和临时比较。
- [experiment-records.integration.ts](../../../../tests/research/experiment-records.integration.ts)：真实离线写入器生成的 W&B / TensorBoard 原生文件、失败 run、原件保留与索引重建。
- [experiment-records.spec.ts](../../../../frontend/e2e/experiment-records.spec.ts)：笔记、多 run 曲线、配置文件及表格关联、跨实验比较和窄屏布局。
- [experiment-tracking.test.ts](../../../../tests/experiments/experiment-tracking.test.ts)、[training-metrics.test.ts](../../../../tests/experiments/training-metrics.test.ts)、[source-refresh.test.ts](../../../../tests/adapters/source-refresh.test.ts)：既有来源和缓存边界。

可选原生读取器与服务集成的准备方式见 [测试指南](../../../playbooks/testing.md)，普通后端回归不要求外部账号或 Python 包。
