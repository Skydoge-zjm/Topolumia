# 原图裁片、表格节选和单表 PDF

## 定位和裁剪

先看原页，找出图表边界与相邻正文。图中应保留轴、图例、面板标记及必要图注；表中应保留首末行、表头、单位、必要标题和脚注。直接抽取 PDF 内嵌位图可能漏掉矢量线条、轴或文字。

[paper_figure.py](../scripts/paper_figure.py) 用 Poppler、Python 和 Pillow 处理原始 PDF。路径相对于本会话打开的 SKILL.md。页号只是命令示例，矩形使用实测坐标。

```text
python "<skill>/scripts/paper_figure.py" labels paper.pdf
python "<skill>/scripts/paper_figure.py" layout paper.pdf 6 --preview page-check.png
python "<skill>/scripts/paper_figure.py" crop paper.pdf 6 "<transfer>/out/figure.png" --box LEFT TOP RIGHT BOTTOM
```

左上角为原点，每个轴从 0 到 1000。layout 输出各文字行的位置和可视底稿，crop 只输出指定矩形。用底稿定位后，打开裁片看四条边和最小字号。若混入旁边的正文、另一幅图、页眉或页码，或截掉了标签，调框重裁。每页单独定位。其他可用的本地 PDF/图像工具也可完成相同操作。将核对过的配图或大型表裁片作为 `image` 块，`role:"source"`，标题、图注和替代文本使用用户语言。

若所选材料无法可靠提取，保留原 PDF、能取得的图表材料与可定位的出处，交付时写明缺项和原因。

## 怎样取数

大型表的完整内容以原表裁片保存。核心结论依赖其部分数据时，再摘录有意义的对照与基线，在标题或说明中标注原表号、行列范围和实验设置。小型表可完整转录。保留原精度、正负号、缺测值、误差和单位。对每个数字同时核对行、列、统计口径，例如“已使用”和“未使用”。见[数值证据](evidence-and-tables.md)。

## 让节点直接显示单表 PDF

将核对过的数值写入 UTF-8 TSV，首行为表头。用[table_tex.py](../scripts/table_tex.py)生成单个 tabular 片段。需保留数学公式或多层表头时可自行写 TeX 片段。表头与说明使用用户语言，保留技术名称和单位。

```text
python "<skill>/scripts/table_tex.py" checked.tsv "<transfer>/out/main-result.tex"
```

上传时使用 `relativePath:"out/main-result.tex"` 和 `mediaType:"application/x-tex"`。组块时以下面的顺序放入实际资产与出处，未制作原表裁片时仅保留第一种表示。

```json
{
  "type": "table",
  "title": "核心实验 · 表 2 节选",
  "representations": [
    {"kind":"asset","role":"rendering","assetId":"<TeX 资产 ID>","label":"单表排版"},
    {"kind":"asset","role":"source","assetId":"<原表裁片 ID>","label":"原表裁片"}
  ],
  "sourceRefs":[{"kind":"table","value":"Table 2","assetId":"<论文 PDF 资产 ID>","locator":{"page":"6","table":"2"}}]
}
```

首个表示放 TeX，整块省略 `payload`，让排版预览成为默认视图。索引异步进行。用 `read_assets(assetId=...,view="metadata")` 查 `asset.compiled.state`，就绪时核对单表 PDF 的表头、数字、缺字与裁切。失败则依诊断修正并上传。若服务器缺少编译器但本机能够编译，可附核对过的单页单表 PDF 和可编辑的 TeX 源。仍无法可靠转录时保留有出处的清晰裁片，写清具体缺项。
