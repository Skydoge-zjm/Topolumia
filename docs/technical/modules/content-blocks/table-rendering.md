# XLSX、TeX 与表格展示

用户要求的是可读的研究材料，不能只把源文本贴到页面。原文件、可计算数据和视觉预览承担不同职责。

## 实现入口

- [table-importers.ts](../../../../src/services/topology/table-importers.ts)：表格导入与导出入口。
- [xlsx-presentation.ts](../../../../src/services/topology/xlsx-presentation.ts)、[xlsx-export.ts](../../../../src/services/topology/xlsx-export.ts)：工作簿解析与输出。
- [tex-presentation.ts](../../../../src/services/topology/tex-presentation.ts)、[tex-preview.ts](../../../../src/services/topology/tex-preview.ts)：受支持表格语法与受限编译。
- [table-presentation.ts](../../../../src/domain/research/table-presentation.ts)：显示合同。
- [AssetTablePreview](../../../../frontend/src/features/topology/details/AssetTablePreview.tsx)、[PresentedTable](../../../../frontend/src/features/topology/details/PresentedTable.tsx)：预览与样式呈现。

## XLSX

提取受支持工作表、单元格值、合并范围和样式；预览处理粗体、颜色、对齐与尺寸等已支持信息。值读取提供选择与范围，避免将整个工作簿塞入上下文。

保留上传原件；结构化导出不是逐字节还原工作簿。当前不提供 Excel 的公式重算、宏、全部图表和完整排版兼容。复杂文件需要打开原件核对，不能只凭解析成功宣称完全保真。

## TeX

支持常用表格结构与合并/粗体等语法解析。受限编译使用本机 pdflatex，关闭 shell escape，拒绝危险命令；再用 pdftoppm 生成图片。编译器或相应宏包缺失、语法不支持与超时都会返回诊断。

因此服务本身不内置完整 LaTeX 发行版。语义表格预览与 PDF/图像编译是两种能力，应根据实际可用状态展示，不能把 HTML 表格说成已经编译出的 PDF。

## 显示与编辑

预览与表单切换，不同时展开。普通数据表每页显示 100 行，翻页只改变展示范围，原文件下载和结构化导出仍使用完整内容。带合并单元格的样式预览保持已有的有界网格，避免分页拆开跨行合并；来源预览的截断状态单独显示。

改表格数据需要保留未修改值类型、列身份、caption 等信息；原文件表示不随编辑隐式消失，见 [编辑机制](editing.md)。

实验的文件行关联使用原文件中的行坐标，包含表头。XLSX 与 CSV 的范围读取直接解析归档原件，不受预览行数截断影响；TeX 限于当前可解析的表格范围。关联保存工作表及块版本，不能在当前块编辑后改为指向新数据。

## 验证

[table-importers.test.ts](../../../../tests/research/table-importers.test.ts) 覆盖导入、合并和样式；[styled-table-fixture.ts](../../../../fixtures/research/styled-table-fixture.ts) 提供实际文件样例；[research-table-import.spec.ts](../../../../frontend/e2e/research-table-import.spec.ts) 检查上传后的浏览器呈现。

需要验证编译图像时先检查本机依赖；测试跳过编译分支不代表它已通过。也不需要为文案修改反复运行真实编译链。
