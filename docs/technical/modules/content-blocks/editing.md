# 内容块编辑与版本

入口：[编辑器](../../../../frontend/src/features/topology/details/ContentBlockEditor.tsx)、[变更服务](../../../../src/services/research/changes/change-service.ts)、[块 Schema](../../../../src/domain/research/content-blocks.ts)。

## 局部修改

编辑已有块时，以原 payload 为底稿，只提交用户真正修改的字段。重命名仅发送 title；不能用表单已知字段重建整份 payload，否则条件、脚注、翻译、文件名、工作表范围和图表配置等会被清空。

PATCH 中省略表示保留，允许的 null 表示移除；创建默认值与编辑默认值不能混用。精确可清除字段以 [操作 Schema](../../../../src/domain/research/changes/operations.ts) 和模拟逻辑为准。

指标逐项编辑，保留 condition、note、sourceRefIds 等没有展示为主输入的字段。不能先转成简单 TSV 再还原，这会改变数值类型并丢失科学语境。

表格保留列 key 及未修改的 number/boolean/null；用户实际编辑的单元格可以成为文本，不能把所有单元格在打开表单时就字符串化。人工修改结构化表时明确 sourceFormat=manual，原始文件表示仍保留。

只有文件表示而没有内联 payload 的块，改标题不能自动创建空内联正文。渲染器判断表格内联内容时检查实际 columns 长度，避免空表遮住已上传文件。

## 来源和表示

保留 sourceRef 的 ID、locator、标签和资产关联。编辑来源值不能用新的随机 ID 替换旧身份，已有指标或表示可能引用它。

表示绑定与解绑也是版本化变更；原始资产和转录表不是同一份证据。编辑标题、说明、核心或其他块不能隐式清除表示集合。

## 并发与错误

更新、归档和排序使用对应观察版本。409 显示在块附近，允许载入最新数据；载入后需要用户重新决定，不能自动继续删除。

提交中防止重复操作。渲染/编辑切换不应提前写回数据，取消不产生科研变更。正文保留原文，界面翻译不能改写科学内容。

## 验证

[ContentBlockEditor.spec.tsx](../../../../frontend/src/features/topology/details/ContentBlockEditor.spec.tsx) 覆盖重命名、各类 payload、来源、纯表示与值类型保留；[research-edit-integrity.spec.ts](../../../../frontend/e2e/research-edit-integrity.spec.ts) 验证浏览器到存储的往返；[reliability.spec.ts](../../../../frontend/e2e/reliability.spec.ts) 验证冲突重载与明确删除。

新增字段后优先确认往返编辑不丢失，而不是仅验证首次创建成功。
