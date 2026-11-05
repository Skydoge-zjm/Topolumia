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

SSH 保存配置与已登录连接分开；远程探测由受控连接执行。Agent 原生终端不会因应用登录 SSH 自动拥有同一通道，梗概必须提示它自行连接目标主机。

## Agent 上下文

get_environment 读取选择与缓存，不启动发现、导入包或执行新命令。返回绑定、解释器命令前缀、关键组件、有限资源观察、检测时间与过期状态。

缓存指纹包含项目、环境及远程绑定；读取中绑定改变需要识别，不返回混合主机结果。空闲显存是观察快照，不是资源承诺；训练前由 Agent 自行核实。

## 边界与验证

科研环境切换不切换 Topolumia 的 Node.js，不自动重启全部 Agent 或调度远程训练。训练资源管理和远程执行编排尚未交付。

[research-environment-context.test.ts](../../../../tests/environments/research-environment-context.test.ts) 验证小梗概、缓存与边界；[environment-catalog.test.ts](../../../../tests/environments/environment-catalog.test.ts)、[research-environment-service.test.ts](../../../../tests/environments/research-environment-service.test.ts) 验证选择与探测；[ssh-connections.test.ts](../../../../tests/environments/ssh-connections.test.ts)、[ssh-environment.test.ts](../../../../tests/environments/ssh-environment.test.ts) 验证连接与远程操作。

真实 SSH / GPU 检测只在相关变更需要时运行。普通前端修改不要求重复登录、扫描全部环境。
