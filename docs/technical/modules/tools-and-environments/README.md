# 工具、科研环境与 SSH

业务：[科研环境](../../../product/business/research-environment.md)。验收：[工具与环境需求](../../../product/requirements/tools-and-environments.md)。应用运行 Node.js 与科研 Python 明确分开。

## 入口与责任

| 入口 | 责任 |
| --- | --- |
| [ToolEnvironmentService](../../../../src/services/environments/tool-environment-service.ts) | 工具状态、操作与设置协调 |
| [EnvironmentCatalogService](../../../../src/services/environments/environment-catalog-service.ts) | 分层发现本机环境和按需包列表 |
| [ResearchEnvironmentService](../../../../src/services/environments/research-environment-service.ts) | 当前 Python 绑定与对应检测 |
| [research-environment-context](../../../../src/services/environments/research-environment-context.ts) | 给 Agent 的紧凑缓存梗概 |
| [SSH 连接服务](../../../../src/ssh/ssh-connection-service.ts) 与 [环境 Hub](../../../../src/ssh/ssh-environment-hub.ts) | 配置、登录、主机挑战与远程目录/环境操作 |
| [ToolsEnvironmentPage](../../../../frontend/src/features/environments/ToolsEnvironmentPage.tsx) | 主页面；catalog/tree 与 ssh 子目录负责逐级选择 |

精确 API 见 [environments 路由](../../../../src/http/routes/environments.ts) 与 [ssh-http](../../../../src/ssh/ssh-http.ts)。不在文档复制完整探测命令和配置字段。

## 绑定与检测

环境身份包含来源、主机、解释器或前缀和项目目录。展开、探测和设为当前是不同动作。配置变化使相关检测缓存失效，不能将旧环境版本标成新环境结果。

探测脚本使用所选解释器。Python、Jupyter、TensorBoard、W&B、MLflow 与框架组件分别显示状态；GPU 驱动、nvcc Toolkit 和框架 CUDA 分开记录。包列表是按需诊断，不作为默认梗概。

SSH 保存配置与已登录连接分开；远程探测由受控连接执行。手动选择私钥时仅使用指定私钥，不先尝试主机 SSH agent；agent 模式与 SSH 别名配置才使用 agent。Agent 原生终端不会因应用登录 SSH 自动拥有同一通道，梗概必须提示它自行连接目标主机。

断开或服务关闭使正在进行的连接任务失效。目标解析、主机密钥/私钥读取、跳板连接与转发完成后均检查取消状态和连接身份；取消后不再拨号，晚到的通道与客户端立即清理，旧任务不得覆盖重新连接的状态。

## Agent 上下文

get_environment 读取选择与缓存，不启动发现、导入包或执行新命令。返回绑定、解释器命令前缀、关键组件、有限资源观察、检测时间与过期状态。

缓存指纹包含项目、环境及远程绑定；读取中绑定改变需要识别，不返回混合主机结果。空闲显存是观察快照，不是资源承诺；训练前由 Agent 自行核实。

## 边界与验证

科研环境切换不切换 Topolumia 的 Node.js，不自动重启全部 Agent 或调度远程训练。训练资源管理和远程训练执行编排尚未交付。

## 托管实验采集

[环境页](../../../../frontend/src/features/environments/RecordCollectorsPanel.tsx)按主机提供部署并启用、状态、目录、暂停与恢复。主机选择、SSH 登录与项目目录作为部署上下文；实验记录适配器在独立读取环境安装，由平台控制部署、后台启停、检测和恢复。进程能力按主机和登录用户复用，项目采集范围与授权独立保存；浏览环境不改变正在采集的项目。默认在项目目录增量发现原生文件，允许记住附加目录。

状态分别表示部署阶段、进程活性、传输及最近数据，不能沿用旧检查冒充在线。关闭页面不影响后台；断连保留游标与队列，恢复重用稳定身份。仅项目管理者可部署、配置和启停；研究者按科研权限选择运行。项目来源及块选择的查询机制见[实验模块](../experiments-and-sources/README.md)。实现由[托管采集管理器](../../../../src/services/environments/managed-record-collectors.ts)、[受控 Python 部署器](../../../../scripts/runtime/manage-record-collector.py)及[HTTP 入口](../../../../src/http/routes/managed-records.ts)协调。

[research-environment-context.test.ts](../../../../tests/environments/research-environment-context.test.ts) 验证小梗概、缓存与边界；[environment-catalog.test.ts](../../../../tests/environments/environment-catalog.test.ts)、[research-environment-service.test.ts](../../../../tests/environments/research-environment-service.test.ts) 验证选择与探测；[ssh-connections.test.ts](../../../../tests/environments/ssh-connections.test.ts)、[ssh-environment.test.ts](../../../../tests/environments/ssh-environment.test.ts) 验证连接与远程操作。

真实 SSH / GPU 检测只在相关变更需要时运行。普通前端修改不要求重复登录、扫描全部环境。

读取器按主机用户和工具共享独立 venv，项目来源分别持有目录、授权、进程实例和队列。本机通过受控子进程部署，远程使用已认证 SSH 的执行及回环反向转发；重连重建通道，队列以稳定来源身份绑定而不绑定临时端口。后台定时检测进程与状态文件，私有实例控制请求完成停止；工作台离线时保留后台与待发数据。

部署需要可用的 Python 3.10+ 和包下载源，支持所选解释器环境的 pip 配置。依赖准备、安装、启动、错误和接收时间分别反馈；可重试部署，不改写训练依赖。单目录恢复不影响其他采集目录，重复或互相包含的采集范围被拒绝。相关验证见[采集器回归](../../../../scripts/testing/test-experiment-collector.py)、[记录接收回归](../../../../tests/research/record-ingestion.test.ts)及环境页测试。
