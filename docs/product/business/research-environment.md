# 科研环境的含义

所选科研环境定义研究任务应使用的主机、项目目录和 Python 解释器。它可以来自系统 Python、Conda、venv 或其他已支持来源。

Topolumia 自身的 Node.js 是应用运行环境，不能被当成科研 Python 环境的组成，也不能随科研环境选择而切换。

## 查看、检测、选择

展开环境只是在浏览；检测获取对应环境的组件状态；设为当前才改变项目选择。界面与 Agent 上下文必须一致表达这一区别。

选择环境后应检测对应 Python、科研框架、Jupyter、TensorBoard、W&B 等关键组件版本。GPU 驱动、CUDA Toolkit 与框架使用的 CUDA 是不同事实，必须分别呈现；组件缺失或检测失败应显式说明。

所有包及版本属于用户按需查看的诊断能力，不应作为默认 Agent 上下文，也不需要暴露专用 MCP 包清单工具。

## 本机与远程

SSH 连接配置、登录、主机校验、远端目录和解释器选择共同确定远程环境。已有连接配置不代表当前已经登录；查看远端环境不代表当前 Agent 在远端执行。

Agent 获取的是准确、紧凑、有检测时间的环境梗概与执行提示，再自行使用原生工具探索和执行。MCP 不承担通用远程 Shell，也不为每次获取梗概重新探测整个环境。

需求：[工具与环境](../requirements/tools-and-environments.md)；机制：[环境模块](../../technical/modules/tools-and-environments/README.md)。
