# 会话历史、事件流与媒体

跨域数据归属见 [存储架构](../../architecture/data-and-storage.md)，事件语义见 [Trace 适配](trace-adapters.md)。

## 历史检查点

[AgentHistoryStore](../../../../src/services/agents/agent-history-store.ts) 使用每项目 SQLite，将会话元信息、回合、Trace 和 conversationEvents 分记录保存，只更新变化记录。历史不接受 maxSessions，也不按置顶、归档或年龄自动删除。

初始化时恢复历史；会话摘要轮询复用已恢复的运行/历史对象，只为缺失身份读取完整历史，不重复反序列化全部消息。摘要响应不包含消息正文。

[sessionCheckpoint](../../../../src/services/agents/session-checkpoint.ts) 定义保存快照；[AgentSessionPersistence](../../../../src/services/agents/agent-session-persistence.ts) 调度周期检查点和结束落盘。持续 delta 不能无限推迟保存；失败通过 persistence 状态暴露并允许重试，不能让一次错误永久破坏保存队列。

Trace 的 maxEventsPerSession 只控制诊断快照数量，完整会话正文独立保留。启动任务按会话登记，MCP 绑定、driver 创建和启动的异步边界均检查关闭状态与运行实例；关闭/停机先阻止新任务，清理并等待尚未完成的启动，随后停止驱动、等待正在捕获的图像、标记未结束回合，再保存并关闭数据库。晚到的 driver 不得把已关闭的会话恢复为 ready。

## SSE 与恢复

[streams.ts](../../../../src/http/streams.ts) 处理当前授权和背压。超过有界队列时断开，通过 cursor 和 HTTP 持久化快照补回；不能无限积压输出。

前端合并要保留较新状态和补回的旧正文，不把绝对文本当增量。切换会话、刷新和继续操作不能让上半段对话消失。

conversationEvents 与 Trace 按回合、执行方、内容身份建立更新索引，流式片段不逐次扫描完整历史。消息和删除标记仍完整保留；不可变快照分支各自校验索引，不共享错误的位置。共享 JSONL 传输按 stdin 背压顺序发送，写入失败统一拒绝待处理请求并清理子进程，不能以未捕获的流错误结束工作台。

## 会话图像

[AgentAttachmentStore](../../../../src/services/agents/agent-attachment-service.ts) 将上传图片保存到会话专属目录，验证真实类型、可解码性、单图大小、数量与解码像素，并生成实际 WebP 缩略图。界面缩小原图不算生成缩略图。

未发送草稿可以删除；被回合或队列引用的媒体不能误删。过期清理先查引用，不能仅按年龄决定。发送原生 Agent 的仍是原始图像，适配方式见 [prompt-images](../../../../src/adapters/agents/shared/prompt-images.ts)。

imageView 输出按稳定调用身份捕获原件；源文件删除或覆盖不改变历史快照，事件重放复用已有图像。字节不进入事件正文或默认 MCP 上下文。

媒体请求与 ETag/304 均先鉴权。科研资产与会话图片不同；需要成为科研成果时通过领域资产绑定处理，而非直接复用磁盘路径。

## 验证

[history-store.test.ts](../../../../tests/agents/sessions/history-store.test.ts) 验证历史容量与恢复；[reliability.test.ts](../../../../tests/agents/sessions/reliability.test.ts) 验证连续保存、撤权、缩略图、源文件消失与草稿引用；[agent-image-input.spec.ts](../../../../frontend/e2e/agent-image-input.spec.ts) 验证用户附件入口。

[startup-races.test.ts](../../../../tests/agents/sessions/startup-races.test.ts) 覆盖延迟创建/启动期间的关闭与停机；[jsonl-process-cleanup.test.ts](../../../../tests/agents/protocol/jsonl-process-cleanup.test.ts) 覆盖写入退出、背压顺序及 Windows 子进程树清理。
