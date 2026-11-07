import { useMemo, useState } from "react";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import type { ContentBlock } from "./ContentBlockRenderer";
import { contentBlockTypes } from "@domain/research/content-blocks";
import { inspectRecordAssets } from "./experimentRecordImport";
import { ProviderRunPicker } from "./ProviderRunPicker";
import { RecordRunAssignment } from "./RecordRunAssignment";
import { runStatusLabel } from "@/features/experiments/runPresentation";

export type ImportedAsset = { id: string; preview: any | null; originalName: string };
const labels: Record<string, [string, string]> = {
  richText: ["文字 / Markdown", "Rich text / Markdown"], metric: ["指标", "Metrics"], table: ["表格", "Table"], image: ["图片 / 截图", "Image"], document: ["文档", "Document"], spreadsheet: ["电子表格", "Spreadsheet"], link: ["链接", "Link"], quote: ["原文摘录", "Quote"], code: ["代码 / 命令", "Code"], chart: ["图表", "Chart"], file: ["文件", "File"], experimentRecord: ["实验记录", "Experiment record"],
};
const accepts: Record<string, string> = {
  table: ".tex,.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv",
  spreadsheet: ".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv",
  document: ".pdf,.tex,.md,.txt,application/pdf,text/markdown,text/plain",
  image: ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp",
  file: "*/*",
  experimentRecord: "*/*",
};
const toTsv = (payload: any) => !payload?.columns?.length ? "" : [payload.columns.map((column: any) => column.label).join("\t"), ...(payload.rows ?? []).map((row: any) => payload.columns.map((column: any) => String(row[column.key] ?? "")).join("\t"))].join("\n");
const parseTsv = (value: string, previous: any) => {
  const lines = value.split(/\r?\n/).filter(line => line.length).map(line => line.split("\t"));
  if (!lines.length) return undefined;
  const used = new Set<string>();
  const columns = lines[0].map((label, index) => {
    let key = previous?.columns?.[index]?.key ?? "c" + (index + 1);
    while (used.has(key)) key += "_";
    used.add(key);
    return { key, label: label || "Column " + (index + 1) };
  });
  const rows = lines.slice(1).map((values, rowIndex) => Object.fromEntries(columns.map((column, i) => {
    const raw = values[i] ?? "", old = previous?.rows?.[rowIndex]?.[column.key];
    const value = String(old ?? "") === raw ? (old === undefined ? raw : old)
      : typeof old === "number" && raw.trim() && Number.isFinite(Number(raw)) ? Number(raw)
      : typeof old === "boolean" && /^(true|false)$/.test(raw) ? raw === "true" : raw;
    return [column.key, value];
  })));
  return { ...previous, columns, rows, sourceFormat: "manual" };
};
const RECORD_OPTIONS = [
  { type: "experimentRecord", provider: "wandb" as const, label: ["实验记录—W&B", "Experiment record — W&B"] as [string, string] },
  { type: "experimentRecord", provider: "tensorboard" as const, label: ["实验记录—TensorBoard", "Experiment record — TensorBoard"] as [string, string] },
  { type: "experimentRecord", provider: "mlflow" as const, label: ["实验记录—MLflow", "Experiment record — MLflow"] as [string, string] },
];
const defaults = (type: string): any => ({
  richText: { format: "markdown", body: "" }, metric: { items: [] }, image: { alt: "" },
  document: { format: "text" }, spreadsheet: { format: "xlsx" }, link: { url: "" },
  quote: { text: "", sourceRefIds: [] }, code: { code: "" }, chart: { chartType: "line", dataBlockId: "", config: {} }, file: {},
  experimentRecord: { provider: "wandb", runs: [] },
})[type];
type BlockEdit = { title?: string; type?: string; payload?: any; sourceRefs?: any[]; review?: string; representations?: any[]; primaryRepresentationId?: string | null };

export function ContentBlockEditor({ en, initial, onSave, onCancel, onUpload, experimentId }: {
  en: boolean;
  initial?: Partial<ContentBlock>;
  onSave: (value: BlockEdit) => Promise<void> | void;
  onCancel: () => void;
  onUpload?: (file: File) => Promise<ImportedAsset>;
  experimentId?: string;
}) {
  const [title, setTitle] = useState(initial?.title ?? ""), [type, setType] = useState(initial?.type ?? "richText");
  const [provider, setProvider] = useState<"wandb" | "tensorboard" | "mlflow">((initial?.payload?.provider as "wandb" | "tensorboard" | "mlflow") ?? "wandb");
  const [pickRuns, setPickRuns] = useState(false);
  const [payload, setPayload] = useState<any>(() => initial?.id ? structuredClone(initial.payload) : initial?.payload === undefined ? defaults(initial?.type ?? "richText") : structuredClone(initial.payload));
  const [tableText, setTableText] = useState(() => toTsv(initial?.payload));
  const [sourceRefs, setSourceRefs] = useState<any[]>(() => structuredClone(initial?.sourceRefs ?? []));
  const [files, setFiles] = useState<File[]>([]), [representations, setRepresentations] = useState<any[]>(initial?.representations ?? []), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const field = (key: string, value: any) => setPayload((current: any) => ({ ...(type === "table" ? { columns: [], rows: [] } : defaults(type)), ...current, [key]: value }));
  const textField = (key: string, zh: string, english: string, multiline = false) => <label>{en ? english : zh}{multiline
    ? <textarea rows={3} value={payload?.[key] ?? ""} onChange={event => field(key, event.target.value)} />
    : <input value={payload?.[key] ?? ""} onChange={event => field(key, event.target.value)} />}</label>;
  const options = useMemo(() => [
    ...contentBlockTypes.filter(value => value !== "experimentRecord").map(value => ({ value, label: labels[value]?.[en ? 1 : 0] ?? value })),
    ...(experimentId || initial?.type === "experimentRecord" ? RECORD_OPTIONS.map(option => ({ value: "experimentRecord:" + option.provider, label: option.label[en ? 1 : 0] })) : []),
  ], [en, experimentId, initial?.type]);
  const resetType = (next: string) => {
    const choice = RECORD_OPTIONS.find(option => "experimentRecord:" + option.provider === next);
    const kind = choice ? "experimentRecord" : next;
    setType(kind);
    setFiles([]);
    setTableText("");
    setError("");
    if (kind === "experimentRecord") {
      // Keep already-selected runs when only the provider changes; validation reports the mismatch.
      const runs = choice && provider !== choice.provider ? payload?.runs ?? [] : [];
      if (choice) setProvider(choice.provider);
      setPayload({ provider: choice?.provider ?? provider, runs });
      return;
    }
    setPayload(defaults(kind));
  };
  const uploadFiles = async () => {
    const reps = [...representations];
    if (reps.length + files.length > 40) throw new Error(en ? "A block can contain up to 40 representations." : "每个内容块最多保存 40 份材料表示。");
    for (const file of files) {
      if (!onUpload) throw new Error(en ? "File upload is unavailable." : "当前无法上传文件。");
      const imported = await onUpload(file);
      reps.push({ kind: "asset", assetId: imported.id, role: /\.tex$/i.test(file.name) ? "rendering" : /\.(xlsx|csv)$/i.test(file.name) ? "transcription" : "source", label: imported.originalName });
    }
    return reps;
  };
  const readRecords = async () => {
    setSaving(true); setError("");
    try { const reps = await uploadFiles(); setRepresentations(reps); setFiles([]); const value = await inspectRecordAssets(provider, reps, payload?.runs); setPayload(value); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const fileInput = (label: string) => <label>{label}<input type="file" multiple aria-label={label} accept={accepts[type]} onChange={event => setFiles(Array.from(event.target.files ?? []))} />{files.length > 0 && <small>{files.map(file => file.name).join("；")}</small>}</label>;

  return <form className="content-block-editor" onSubmit={async event => {
    event.preventDefault(); setSaving(true); setError("");
    try {
      if (!title.trim()) throw new Error(en ? "A title is required." : "请输入内容块标题。");
      let nextPayload = payload;
      if (type === "table" && tableText !== toTsv(payload)) nextPayload = parseTsv(tableText, payload);
      const sources = sourceRefs.map(source => { const value = { ...source }; delete value.delivery; return value; });
      const reps = await uploadFiles();
      if (type === "experimentRecord" && files.length) { setRepresentations(reps); setFiles([]); nextPayload = await inspectRecordAssets(provider, reps, payload?.runs); setPayload(nextPayload); }
      if (type === "experimentRecord" && !nextPayload?.runs?.length) throw new Error(en ? "Read a record file or select an existing run." : "请先读取记录文件或选择已有运行。");
      if (files.length && ["document", "spreadsheet"].includes(type)) {
        const name = files[0].name;
        const format = type === "spreadsheet" ? (/\.csv$/i.test(name) ? "csv" : "xlsx")
          : /\.tex$/i.test(name) ? "tex" : /\.pdf$/i.test(name) ? "pdf" : /\.md$/i.test(name) ? "markdown" : "text";
        nextPayload = { ...payload, format };
      }
      if (!nextPayload && !reps.length) throw new Error(en ? "Add content or choose a file." : "请添加内容或选择文件。");
      const value: BlockEdit = { title: title.trim(), type, ...(nextPayload !== undefined ? { payload: nextPayload } : {}), representations: reps, sourceRefs: sources, review: initial?.review ?? "unreviewed" };
      if (initial?.primaryRepresentationId && !reps.some(rep => rep.id === initial.primaryRepresentationId)) value.primaryRepresentationId = null;
      if (initial?.id) {
        // Existing research fields are patched only when changed by this editor.
        for (const key of Object.keys(value) as Array<keyof BlockEdit>) {
          const original = key === "sourceRefs" ? (initial.sourceRefs ?? []).map(source => { const v = { ...source }; delete v.delivery; return v; })
            : key === "representations" ? initial.representations ?? [] : initial[key as keyof typeof initial];
          if (JSON.stringify(value[key]) === JSON.stringify(original)) delete value[key];
        }
        if (type !== initial.type && nextPayload === undefined && initial.payload !== undefined) value.payload = null;
      }
      await onSave(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : (en ? "Unable to save this content block." : "无法保存这个内容块。")); }
    finally { setSaving(false); }
  }}>
    <div className="research-form-grid"><label>{en ? "Block title" : "内容块标题"}<input required value={title} onChange={event => setTitle(event.target.value)} placeholder={en ? "e.g. Table 2 metrics" : "例如：Table 2 指标"} /></label><label>{en ? "Content type" : "内容类型"}<SelectMenu ariaLabel={en ? "Content type" : "内容类型"} value={type === "experimentRecord" ? "experimentRecord:" + provider : type} onChange={resetType} options={options} /></label></div>
    {type === "experimentRecord" && <>{onUpload && fileInput(en ? "Upload run records" : "上传运行记录")}<div className="experiment-run-toolbar"><button type="button" className="button" disabled={saving || !files.length && !representations.length} onClick={() => void readRecords()}>{saving ? en ? "Reading…" : "读取中…" : en ? "Read records" : "读取记录"}</button><button type="button" className="button" onClick={() => setPickRuns(true)}>{en ? "Select existing runs" : "选择已有运行"}</button></div>{payload?.runs?.length > 0 && <div className="research-table-wrap"><table className="research-table"><thead><tr><th>{en ? "Run" : "运行"}</th><th>{en ? "Status" : "状态"}</th><th>{en ? "Files" : "文件"}</th><th>{en ? "Actions" : "操作"}</th></tr></thead><tbody>{payload.runs.map((run: any) => <tr key={run.sourceId}><td>{run.label}{experimentId && <RecordRunAssignment experimentId={experimentId} runId={run.runId} en={en} onChange={runId => field("runs", payload.runs.map((item: any) => { if (item.sourceId !== run.sourceId) return item; const next = { ...item }; if (runId) next.runId = runId; else delete next.runId; return next; }))} />}</td><td>{runStatusLabel(run.status, en)}</td><td>{run.assetIds.length}</td><td><button type="button" className="button" onClick={() => field("runs", payload.runs.filter((item: any) => item.sourceId !== run.sourceId))}>{en ? "Remove" : "移除"}</button></td></tr>)}</tbody></table></div>}{pickRuns && <ProviderRunPicker provider={provider} en={en} onClose={() => setPickRuns(false)} onSelect={runs => { field("runs", [...new Map([...(payload?.runs ?? []), ...runs].map(run => [run.sourceId, run])).values()]); setPickRuns(false); }} />}</>}
    {type === "richText" && <>{textField("body", "文字 / Markdown", "Text / Markdown", true)}<SelectMenu ariaLabel={en ? "Text format" : "文字格式"} value={payload?.format ?? "markdown"} onChange={value => field("format", value)} options={["markdown", "plain", "html"].map(value => ({ value, label: value }))} /></>}
    {type === "metric" && <MetricFields items={payload?.items ?? []} en={en} onChange={items => field("items", items)} />}
    {type === "table" && <><label>{en ? "Paste a table (tab-separated; first row is the header)" : "粘贴表格（Tab 分隔；第一行为表头）"}<textarea rows={5} value={tableText} onChange={event => setTableText(event.target.value)} /></label>{textField("caption", "表格说明", "Table caption")}{onUpload && fileInput(en ? "Or import TeX / XLSX / CSV" : "或导入 TeX / XLSX / CSV 表格")}</>}
    {type === "spreadsheet" && <>{onUpload && fileInput(en ? "Upload XLSX / CSV" : "上传 XLSX / CSV")}<div className="research-form-grid">{textField("sheet", "工作表", "Worksheet")}{textField("range", "单元格范围", "Cell range")}</div></>}
    {type === "document" && <>{onUpload && fileInput(en ? "Upload PDF / TeX / Markdown" : "上传 PDF / TeX / Markdown")}{textField("title", "文档标题", "Document title")}</>}
    {type === "image" && <>{onUpload && fileInput(en ? "Upload image / screenshot" : "上传图片 / 截图")}{textField("alt", "图像描述", "Image description")}{textField("caption", "图注", "Figure caption", true)}{textField("locator", "原文定位", "Source location")}</>}
    {type === "file" && <>{onUpload && fileInput(en ? "Upload file" : "上传文件")}{textField("label", "文件名称", "File label")}{textField("note", "备注", "Note", true)}</>}
    {type === "link" && <>{textField("label", "链接名称", "Link label")}{textField("url", "链接地址", "URL")}{textField("kind", "链接类型", "Link kind")}{textField("note", "备注", "Note", true)}</>}
    {type === "quote" && <>{textField("text", "原文摘录", "Quoted text", true)}{textField("translation", "译文", "Translation", true)}{textField("note", "备注", "Note", true)}</>}
    {type === "code" && <>{textField("language", "语言 / 格式", "Language / format")}{textField("filename", "文件名", "Filename")}{textField("code", "代码 / 命令 / 配置", "Code / command / configuration", true)}</>}
    {type === "chart" && <div className="research-form-grid"><label>{en ? "Chart type" : "图表类型"}<SelectMenu ariaLabel={en ? "Chart type" : "图表类型"} value={payload?.chartType ?? "line"} onChange={value => field("chartType", value)} options={["line", "bar", "scatter", "area"].map(value => ({ value, label: value }))} /></label>{textField("dataBlockId", "数据内容块 ID", "Data content block ID")}</div>}
    <details><summary>{en ? "Sources" : "来源引用"} · {sourceRefs.length}</summary>{sourceRefs.map((source, index) => <div className="research-form-grid" key={source.id ?? index}><label>{en ? "Source type" : "来源类型"}<SelectMenu ariaLabel={(en ? "Source type " : "来源类型 ") + (index + 1)} value={source.kind} onChange={kind => setSourceRefs(items => items.map((item, i) => i === index ? { ...item, kind } : item))} options={["url", "doi", "arxiv", "file", "page", "figure", "table", "section", "range"].map(value => ({ value, label: value }))} /></label><label>{source.label || (en ? "Source" : "来源")}<input aria-label={(en ? "Source " : "来源 ") + (index + 1)} value={source.value} onChange={event => setSourceRefs(items => items.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} /></label></div>)}<button className="button" type="button" onClick={() => setSourceRefs(items => [...items, { id: "source:" + crypto.randomUUID(), kind: type === "image" ? "figure" : type === "table" ? "table" : "section", value: "" }])}>{en ? "Add source" : "添加来源"}</button></details>
    {representations.length > 0 && <div className="research-form-grid">{representations.map((rep,index) => <div key={rep.id || rep.assetId}><span>{rep.label || rep.assetId || rep.url}</span><SelectMenu ariaLabel={en ? "Representation role" : "材料角色"} value={rep.role} onChange={role => setRepresentations(items => items.map((item,i) => i === index ? {...item,role} : item))} options={[{value:"source",label:en?"Original source":"原始来源"},{value:"transcription",label:en?"Transcription":"转录数据"},{value:"rendering",label:en?"Rendering":"排版版本"},{value:"supplement",label:en?"Supplement":"补充材料"}]} /><button type="button" className="button" onClick={() => setRepresentations(items=>items.filter((_,i)=>i!==index))}>{en?"Remove":"移除"}</button></div>)}</div>}
    {error && <p role="alert">{error}</p>}<footer><button type="button" className="button" onClick={onCancel}>{en ? "Cancel" : "取消"}</button><button className="button primary" disabled={saving}>{saving ? (en ? "Saving…" : "保存中…") : (en ? "Save block" : "保存内容块")}</button></footer>
  </form>;
}

function MetricFields({ items, en, onChange }: { items: any[]; en: boolean; onChange: (items: any[]) => void }) {
  const set = (index: number, key: string, value: any) => onChange(items.map((item, i) => i === index ? { ...item, [key]: value } : item));
  return <div>{items.map((item, index) => <fieldset key={index} className="research-card"><legend>{en ? "Metric" : "指标"} {index + 1}</legend><div className="research-form-grid">{[
    ["name", "名称", "Name"], ["value", "数值", "Value"], ["unit", "单位", "Unit"], ["split", "数据划分", "Data split"], ["condition", "实验条件", "Condition"], ["note", "备注", "Note"],
  ].map(([key, zh, english]) => <label key={key}>{en ? english : zh}<input value={item[key] ?? ""} onChange={event => {
    const value = event.target.value;
    set(index, key, key === "value" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : value);
  }} /></label>)}<label>{en ? "Direction" : "优化方向"}<SelectMenu ariaLabel={en ? "Direction" : "优化方向"} value={item.direction ?? "none"} onChange={value => set(index, "direction", value)} options={[{value:"none",label:en?"None":"无"},{value:"min",label:en?"Lower is better":"越小越好"},{value:"max",label:en?"Higher is better":"越大越好"}]} /></label></div><button className="button" type="button" onClick={() => onChange(items.filter((_, i) => i !== index))}>{en ? "Remove metric" : "移除指标"}</button></fieldset>)}<button type="button" className="button" onClick={() => onChange([...items, { name: "", value: "" }])}>{en ? "Add metric" : "添加指标"}</button></div>;
}
