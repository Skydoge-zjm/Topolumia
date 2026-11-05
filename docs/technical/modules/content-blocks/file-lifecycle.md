# 科研文件生命周期

入口：[资产服务](../../../../src/services/research/assets/asset-service.ts)、[Repository](../../../../src/services/research/objects/repository.ts)、[用户路由](../../../../src/http/routes/research/nodes.ts)。跨域存储归属见 [存储架构](../../architecture/data-and-storage.md)。

## 上传与保存

用户上传经过流式接收、大小/权限等校验并计算校验值；字节先进入受控 incoming 临时文件，再成为 objects 下的资产原件。数据库保存资产 ID、storageKey、校验值、处理与绑定状态。

文件字节不放进 SQLite payload，也不放进 Agent 默认上下文。应用磁盘路径不是用户或 Agent 的通用读取入口。

资产处理生成表格预览或 TeX 派生文件，状态和诊断独立于原件是否保存成功。处理失败应保留原件并说明可用能力，不能展示伪造预览。

## 绑定

内容块 representation 用 assetId 绑定原件、渲染或补充形式；来源也可引用资产。候选使用的资产需要保留，接受后成为正式绑定，解绑不能误删仍被其他内容或历史引用的原件。

节点和组使用类型化 owner 识别块归属；资产保留判断覆盖节点、组、候选与历史。组删除或移除成员不能按路径删除成员文件。详细合同见 [组接口与变更](../node-groups/interfaces-and-changes.md)。

当前状态与保留判断由资产服务和变更提交管理。不要在前端关闭对话框或删除节点时直接按路径删除文件，也不要自行增加全目录年龄清理。

## 读取与表示

- 元数据、预览和原件分别读取，均检查项目和可见范围。
- 图片实际渲染，PDF 使用受控下载入口展示；不支持的格式仍可下载。
- TeX/XLSX/CSV 按表格能力处理；派生结果记录状态，原文件可用不意味着已得到文本索引。
- 内联正文与文件表示可切换。representation 选择是浏览状态，不应自动覆盖内容。

## Agent 文件交接

[MCP 绑定](../../../../src/agent/research-mcp-binding.ts) 创建会话专属 transfer 根，Agent 使用自己的文件工具写 out/ 或读取 in/。transfer_asset 负责受控上传下载，输入为相对路径与幂等标识，不接受任意绝对路径读取。

普通来源文件未进入资产库时，使用来源提示和原生读取；不能把所有项目文件一律上传或重复索引。会话图片附件属于另一套生命周期，见 [会话媒体](../agent-workbench/sessions-and-media.md)。

## 导出与验证

保留原件下载；可计算表格支持实现范围内的 XLSX/TeX 导出，编译表示仅在生成成功时提供。导出记录版本和幂等请求，不能将被截断的预览冒充完整文件。

验证：[protocol.test.ts](../../../../tests/research/interface/protocol.test.ts) 的传输与资产合同、[research-table-import.spec.ts](../../../../frontend/e2e/research-table-import.spec.ts) 的真实文件链路。表格限制见 [表格展示](table-rendering.md)。
