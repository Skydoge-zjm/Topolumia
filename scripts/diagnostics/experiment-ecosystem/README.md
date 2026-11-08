# 实验记录生态实测

这些脚本生成合成实验，调用真实 SDK，保留原生文件、完整 protobuf 解码、API 结果、增量观察、原始文件清单和现有 Topolumia 读取器的输出。它们是诊断工具，不是已交付的实时适配器。

从仓库根运行，使用新的空输出目录：

```powershell
python -m venv runtime/experiment-ecosystem-research/venv
runtime/experiment-ecosystem-research/venv/Scripts/python.exe -m pip install -r requirements/experiment-ecosystem-research.txt
runtime/experiment-ecosystem-research/venv/Scripts/python.exe scripts/diagnostics/experiment-ecosystem/probe.py --output runtime/experiment-ecosystem-research/reproduction
runtime/experiment-ecosystem-research/venv/Scripts/python.exe scripts/diagnostics/experiment-ecosystem/analyze.py --output runtime/experiment-ecosystem-research/reproduction
```

macOS/Linux 使用 venv/bin/python。原生库、视频编码及 writer 的跨平台表现仍需要在目标平台验证。本次实际使用 Windows / Python 3.13.12；完整依赖快照保存在本机研究输出目录旁。

W&B 强制使用隔离配置和 offline 模式，MLflow 使用输出目录内的 SQLite 与本地 artifacts；没有云端账号。writer 子进程只生成小型合成数据。live/crash 阶段会启动、观察并清理其拥有的子进程；以 writer 是否已进入 finish 阶段判断实时性，不把“主进程仍活着”当作未结束。

- `probe.py`：运行产品 writer、训练中增量和异常退出场景、截断/补全记录、调用当前静态读取器。
- `wandb_probe.py`：指标、配置、摘要、媒体、图表、表格、Artifacts、代码、离线续跑及多 run。
- `tensorboard_probe.py`：TensorBoardX、官方 EventFileWriter、插件、旁路文件、重启和并发 writer。
- `mlflow_probe.py`：真实本地 tracking store、参数/指标/文件/数据集、嵌套和继续运行。
- `inspect_records.py`：完整原生事件解码；比较 EventAccumulator 的 purge 行为。
- `analyze.py`：按实际记录检查证据，不仅检查 API 是否返回成功；生成 evidence-ledger.json。

主输出有 environment.json、research-summary.json、inspection、current-topolumia-reader、partial-files、evidence-ledger.json 和带 SHA-256 的 file-manifest.json。`api_completed` 只表示调用完成；是否真正记录需看解码和证据检查。原始文件始终保留。

`--inspect-only` 可重新生成派生巡检而不重跑 writer。`--supplement` 为早期样本补充显式 commit、1 秒 W&B 刷新和 MLflow/媒体边界样本；完整的新运行已包括这些场景，无需额外执行。旧样本中没有显式 commit 的观察不能与显式提交样本混为一个时序基线。

当前读取缺口与目标设计见[实验模块](../../../docs/technical/modules/experiments-and-sources/README.md)，验收边界见[持续接收需求](../../../docs/product/requirements/research-workspace.md#持续接收需求待实现)。完整本机调研记录不作为正式文档的读取前提。
