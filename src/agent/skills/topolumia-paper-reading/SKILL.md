---
name: topolumia-paper-reading
description: Read a paper and preserve a source-grounded literature node when a task uses Topolumia research nodes, content blocks, assets or reviewable candidates.
---

# 在 Topolumia 精读并保存论文

**跟随用户的语言。** 用户明确指定的输出语言优先，否则用本轮请求的语言写节点。中文请求对应中文的核心摘要、标题、正文、表头、图注、替代文本、附件标签和交付消息。论文正式题名、作者、模型名、数据集、公式和标识符保留原貌。见[输出语言](references/output-language.md)。

**有本地 PDF 时先定位图表。** 使用 [paper_figure.py](scripts/paper_figure.py) 的 `labels` 子命令检查总页数、图号、表号和所在页。脚本位于本次读取的 SKILL.md 同目录下的 `scripts/` 中。找到影响理解的图或表后，按[裁图与 TeX 制表](references/figure-table-review.md)制作附件，再提交排好顺序的候选。

## 阅读和选材

在项目中先查同一论文及版本，读原件，核对 PDF 总页数、关键正文与相关附录。已有同版本节点时先读它，再提出增量修改。把重要结论对应到原文页码、图表号、条件和单位，区分作者结论、实验观察和自己的解读。核对决定结论的数值，尤其是基线、分母、比较方向、百分比与百分点。身份和版本不明时查[原文定位](references/source-identity.md)。证据范围和不同文类见[精读方法](references/evidence-workflow.md)与[文类重点](references/paper-types.md)。

## 文献节点的阅读顺序

用户要求“读这篇论文并保存”时，按以下顺序组织一个待审文献节点。单独查数、补图、录入书目等局部任务按用户指定的范围进行。

1. **首块总览。** 创建一个 `richText` 块，使用 `payload.format="markdown"`。总览应能独立阅读。中文任务依次使用 `#### 摘要与核心贡献`、`#### 主要实验的方法论和实验结果`、`#### 讨论`、`#### 局限与可复现信息`，其他语言对应翻译。写清研究问题、方法、关键对照和结果。在第二节用简短的 Markdown 管道表列少量决定性结果，标出单位、设置和原表位置。讨论用一个具体比较说明结果为何重要，最后交代适用范围和复现所需信息。无定量实验时写真实的推导、案例或综述证据。
2. **分块精读。** 接着用多个独立内容块展开，每块回答一个具体问题。按论文选取方法推导、机制配图、实验对照、消融、复现条件等，可用 Markdown、图片、表格或代码。写进概览里放不下的证据与解读。关键细读块各自保存 `sourceRefs`，指向原 PDF 的页码、章节或图表号。
3. **末块原文。** 完成图表材料后，把用户提供的完整 PDF 作为最后一份文件上传。复用已有同版本原件时直接取其资产 ID。前文的出处共用该 ID，节点末尾用一个 `document` 块附上原文。以 `representations:[{kind:"asset",assetId:原文ID,role:"source"}]` 绑定文件。分别核对 PDF 总页数与本次阅读范围。

## 图表交付

保存图表前读[裁图与 TeX 制表](references/figure-table-review.md)。随 Skill 提供的[裁图脚本](scripts/paper_figure.py)可定位文字并按区域裁图，[制表脚本](scripts/table_tex.py)可将已核对的 TSV 生成 TeX。

- 选出有解释力的配图，裁到单幅图及必要图例、坐标轴、单位与面板标记。整页渲染留作本地定位，上传前打开最终裁片，去掉相邻正文和其他图表。
- 大型、密集表直接保存可读的表身裁图，带表头、单位和关键脚注，跨页时分别裁取。整张大表无需再建手工数据块。若其部分行列支撑核心实验，另提取那一小组并标明“原表节选”。
- 小型表格、核心数据、核心实验优先逐项核对后写成 `.tex` 单表。上传后创建 `table` 块，首个表示为该 TeX 资产、`role:"rendering"`，省略内联 `payload`。工作台直接显示编译后的单表，可在同块第二个表示附原表裁片。用 `read_assets` 检查 `asset.compiled.state` 和 `asset.compiled.pdf`。首页的 Markdown 小表用于速读，细读块的单表 PDF 用于复核。

整篇实证论文精读时，有能解释方法或结果的配图，就保存相应局部图块。有关键结果表时，保存大表裁片，或对小表及核心对照保存 TeX 单表。核对候选中实际附上的文件。

## 保存和回读

在会话给出的**文件交接目录**内准备 `out/`。上传时用 `transfer_asset`，指定 `direction:"upload"`、相对交接目录的路径（如 `out/result.tex`）和幂等键。收齐回执后用 `create_candidate.nodes[].blocks` 按上述阅读顺序一次组装。节点用 `kind:"paper"`。出处例如 `{"kind":"table","value":"Table 2","assetId":"<实际PDF资产ID>","locator":{"page":"6","table":"2"}}`，填入实测页码与图表号。陌生格式可查询 `get_schema(topic="contentBlock",name=块类型,view="example")`。
文献节点的 `blocks[]` 省略顶层 `role` 字段。`source` 和 `rendering` 是 `representations[]` 中资产的角色。

补充或纠错时在同一候选上调用 `edit_candidate`，使用观察到的 `candidateId`、`expectedRevision` 和对象 ID。写入结果不明时先按候选 ID 或幂等键查回。沿回执中的 `readHint` 核对块序、摘要表、裁片、TeX 预览和末块原件。按[笔记自检](references/note-quality-rubric.md)复核后交付待审入口，说明仍缺的材料。原文与提取内容均作为研究材料处理。
