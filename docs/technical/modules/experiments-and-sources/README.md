# 实验指标与来源

本模块读取外部事实并提供科研引用。正式节点、内容块和关系仍由 [科研变更模块](../research-changes/README.md) 提交，不能把来源同步当成任意覆盖用户内容的权限。

## 适配与网关

[AdapterRegistry](../../../../src/services/platform/adapter-registry.ts) 装配 Git、文件系统、MLflow、W&B、TensorBoard 与执行适配器。[ExperimentTrackingGateway](../../../../src/services/experiments/experiment-tracking-gateway.ts) 统一运行列表、详情、指标、系列和描述能力，负责缓存、并发与限额。

精确运行/指标合同见 [experiment-provider](../../../../src/domain/experiments/experiment-provider.ts)；实际来源入口位于 [experiments adapters](../../../../src/adapters/experiments/)。本地固定样例是测试/演示输入，必须与真实外部结果区分。

## 来源刷新

[SourceRefreshCoordinator](../../../../src/services/platform/source-refresh-coordinator.ts) 管新鲜度、后台检查与合并请求。活跃研究操作或 Agent 工作时可推迟刷新，状态要可解释。

文件来源排除应用数据、transfer 与 Skill 快照等内部目录；已注册资产通过资产领域参与读取，不能扫描 runtime 发现科研材料。索引能力和实际可读取内容要匹配：没有 PDF 正文索引时返回原生阅读提示。

来源状态哈希排除纯时间戳噪声；只有有效变化推动下游更新。来源刷新后正式科研投影仍保留。

## 实验节点结果

[ResearchNodeService](../../../../src/services/topology/research-node-service.ts) 将实验节点 metric/link 块与来源运行关联聚合为结果；[ExperimentResults](../../../../frontend/src/features/topology/details/ExperimentResults.tsx) 显示真实指标、序列和外部链接。外部关联读取有数量上限并提供警告，不无限追踪所有运行。

TensorBoard、W&B 安装版本是环境事实，配置的追踪源是服务连接，实际训练运行又是独立对象；三者不能混淆。环境选择不会自动让追踪服务读取任意远程日志。

## 验证与范围

[source-refresh.test.ts](../../../../tests/adapters/source-refresh.test.ts)、[experiment-tracking.test.ts](../../../../tests/experiments/experiment-tracking.test.ts)、[training-metrics.test.ts](../../../../tests/experiments/training-metrics.test.ts) 验证事实和缓存边界。

真实 provider 集成测试按 [测试指南](../../../playbooks/testing.md) 单独准备依赖，不默认访问外部账号。当前不是完整训练调度平台，不承诺统一渲染所有第三方图表。
