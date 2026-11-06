# 前端状态与事件流

## 责任划分

[App.tsx](../../../frontend/src/app/App.tsx) 负责身份、项目上下文与按路由懒加载。领域数据通过查询缓存读取；界面局部展开、草稿和滚动状态留在对应组件或 Hook，不把整份会话塞入全局 UI Store。

[shared/lib/api.ts](../../../frontend/src/shared/lib/api.ts) 统一请求与项目绑定。跨项目查询键必须包含项目身份；项目切换不能复用其他项目的结果。

## 页面加载

导航与页面外壳先挂载，项目上下文、路由模块和业务数据分别提供等待反馈。路由的 Suspense 与 [PageBoundary](../../../frontend/src/shared/layout/PageBoundary.tsx) 放在正文区域内，页面模块等待或失败都不卸载导航和账号区域。

[LoadingSkeleton](../../../frontend/src/shared/ui/LoadingSkeleton.tsx) 提供布局占位与可访问的忙碌状态，默认等待 150 ms 后显现；减少动态效果时保留占位并关闭脉冲。页面只在缺少目标数据的初次读取时显示骨架，同一查询后台刷新继续显示缓存内容。列表、会话详情、材料和实验结果分别读取，已完成的区域不等待其他区域；Agent 回复仍使用原有 SSE。

会话标题可以先使用列表中的真实摘要，历史区域通过 aria-busy 单独表示是否就绪。详情加载完成前禁用输入与模型设置；切换会话不复用上一会话正文。科研对象和记录修订也按独立查询键读取，修订等待时不在新版本标识下显示旧正文。

模块加载失败最多自动重载一次，仍失败则保留错误和手动重载入口。PageReady 必须放在路由 Suspense 内容内部，在模块成功提交后清除重试标记，不能让等待占位提前清除标记。开发环境中，失败页面在成功热更新后重新载入；错误原因仅在开发环境显示，便于诊断失败的模块。

## 会话

原生协议先在后端归一化。前端 [agentSession.ts](../../../frontend/src/features/agents/conversation/model/agentSession.ts) 合并 HTTP 快照和 SSE；[conversationProjector.ts](../../../frontend/src/features/agents/conversation/model/conversationProjector.ts) 组织可显示内容。

正文、消息 ID、工具调用 ID 和回合 ID 是合并依据。绝对快照不能被再次当作文本增量追加；较旧 HTTP 响应不能覆盖较新队列、权限和保存状态，同时要能补回缺失旧正文。

Trace 保存有界结果快照，完整 conversationEvents 独立保留。展示折叠不是删除历史，也不应重新组合出供应商本来分开的多次思考。

[useAgentSubmission](../../../frontend/src/features/agents/conversation/useAgentSubmission.ts) 管发送、outbox、失败与排队；视口和消息导航分别有 Hook，避免页面组件承担所有状态。

## 科研修改与翻译

写请求携带观察到的对象版本；409 显式显示并提供载入最新内容，不能用新版本自动重试破坏性操作。审批提交后重新获取当前权限和候选状态。

科研正文、文件名、候选原因保留原文，渲染边界使用 translate=no；按钮与提示通过显式中英文文案。内容组件自身承担保护，不能依赖特定父页面。

## 节点组视图

[组投影](../modules/node-groups/topology-projection.md) 保留稳定组入口、共享成员与可还原的边来源。组核心、成员、角色、主边和关系是服务器领域状态；收起、聚焦、筛选、位置与滚动是按用户/项目隔离的浏览状态。搜索临时揭示路径不提交组修改。

布局元素保留类型化对象引用，投影边保留原始关系与端点；不得把前端生成的代理 ID 用于科研写入。组页、节点页和候选预览复用相同正文能力，提交后按真实影响失效缓存，不把全图及成员全文放进 UI Store。

## 负载与交互

SSE 处理背压，超过有界缓冲后断开并由持久化与 cursor 恢复；前端不能假设连接永不丢失。候选关联使用增量更新及 ETag，避免每个字符触发整份历史扫描。

ELK 使用自身 Worker 协议，在后台布局；搜索防抖，正常更新保留已有节点位置与 pan，显式重置才重新布局。

共用 [SelectMenu](../../../frontend/src/shared/ui/SelectMenu.tsx) 等组件；普通比例字体、紧凑过程行、限制输出高度和减少动态效果是工作台约束。

## 标题与页面展示

界面遵循根目录 [DESIGN.md](../../../DESIGN.md)。页面、区块与弹窗只提供单一主标题，不设置英文或数字眉标，不在标题下解释功能和实现机制。共享 PageHeader 与 ResearchDialog 不接收说明副标题；研究正文、摘要、身份、版本和时间在内容字段中展示，错误、状态与操作影响单独反馈。

全局不限制桌面最小宽度。手机导航在自身容器内横向滚动，表格和科研画布限制在各自容器中，登录和普通表单适应视口。界面字号收敛为 12、14、16、24px，数学与导入研究内容保留其必要排版。

项目协作页只展示真实成员、状态、更新时间与接口允许查看的权限；只有具有成员管理权限时才读取待处理邀请。未提供对应行为的邀请、账号创建及权限编辑占位控件不出现在页面中。

科研历程使用紧凑行列表：操作方、行为、时间与结果在首行，对象、原因、提议版本和不同的发起方在次行；窄屏允许必要换行。长内容仅在列表中截断，不改变详情与归因数据。纪要条目使用短日期区与单行正文预览，避免大块留白和重复角色脚注。

验证入口：[agentSession.spec.ts](../../../frontend/src/features/agents/conversation/model/agentSession.spec.ts)、[ContentBlockEditor.spec.tsx](../../../frontend/src/features/topology/details/ContentBlockEditor.spec.tsx)、[reliability.spec.ts](../../../frontend/e2e/reliability.spec.ts)。
