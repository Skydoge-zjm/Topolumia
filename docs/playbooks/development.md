# 启动与开发

从源码根运行命令。需要 package.json 声明范围内的 Node.js、npm 和 Git；不要求先安装科研 Conda 环境。

## 首次启动

```powershell
npm ci
```

没有本机配置时，复制 [配置样例](../../config/topolumia.config.example.json) 为 config/topolumia.config.json。不要覆盖已有文件；保留用户选择的主机、项目根与端口。

```powershell
npm run build
npm start
```

默认访问 http://127.0.0.1:5510；后端从 frontend/dist 服务 React 构建，因此后端地址能看到页面是正常行为。页面需要先完成前端构建。静态资源源文件放 frontend/public，构建产物 frontend/dist 和根目录的后端 dist 均由 Git 忽略。首次访问创建管理员，没有预设账号密码。

## 前端迭代

保持后端运行，在另一终端执行：

```powershell
npm run dev:frontend
```

访问 http://127.0.0.1:5610。Vite 代理 API 到后端，直接读取 frontend/src 和 frontend/public，支持热更新。后端源码修改后需重新构建并重启后端；只刷新浏览器不会加载新的 dist。单独构建后端不要求前端产物存在，也不会删除 frontend/dist。

端口在配置文件 server.port、frontend.port 与 frontend.apiUrl 设置；[Vite 配置](../../frontend/vite.config.ts) 和 [后端配置](../../src/config.ts) 是具体读取实现。不要为了端口设置引入新的环境变量流程。

## 开始改动

协作流程按 [贡献指南](../../CONTRIBUTING.md)：从最新 main 创建短期任务分支，完成后提交 PR，由维护者确认合并。外部贡献者通过 fork 提交。没有明确授权时，Agent 不直接推送 main 或自动合并。

先检查 git status、相关差异和 [任务导航](../README.md)。用户要求先提交时先完成提交；不清空已有未提交工作。

从相关模块入口进入代码，只读取必要背景。小修复直接进行；长任务才在 work/active 创建 plan.md，保存目标、关键进度与下一步。界面沿用共享组件与普通字体。

验证按 [测试指南](testing.md) 选择。构建是转译与产物生成，不代表所有后端代码经过完整类型检查。不得通过修改真实研究数据来制造回归测试前置条件。

## 本机进程

拉起服务前检查监听端口和已有进程，优先复用健康服务。需要后台启动时，在 Windows 使用隐藏窗口并将输出放入忽略的 runtime；只停止确认属于本任务的进程。

临时 Vite 浏览器、SSR 或诊断实例必须显式设置各自的 cacheDir，使用忽略目录中的独立缓存，不与运行中的前端开发服务共用依赖预构建目录。仅做 SSR 模块检查时还应关闭客户端依赖扫描。遇到 `504 Outdated Optimize Dep`，先停止冲突实例，再用 `npm run dev:frontend -- --force` 重启开发服务；验证实际页面与依赖请求，HTTP 首页返回 200 不能证明动态页面可用。

应用数据与科研工作目录见 [存储架构](../technical/architecture/data-and-storage.md)。公开发布入口以根 README 为准，正式产品、技术和操作文档随代码分发；本机任务记录与参考资料不参与发布。
