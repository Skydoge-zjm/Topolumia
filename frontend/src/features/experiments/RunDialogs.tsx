import { useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import {
  ContentBlockRenderer,
  type ContentBlock,
} from "@/features/topology/details/ContentBlockRenderer";
import { AssetTableRowFields, AssetTableRowView } from "./AssetTableRows";
import type {
  ExperimentRun,
  ExperimentMaterialLink,
  MaterialSelection,
} from "@domain/research/experiment-records";
import { runStatusNames as statuses, runStatusLabel } from "./runPresentation";

export type ExperimentRunOverview = ExperimentRun & {
  blockId?: string;
  firstWatermark?: number;
  records: {
    blockId: string;
    blockRevision: number;
    title: string;
    provider: string;
    sourceId: string;
    label: string;
    status: string;
  }[];
};
export type ExperimentMaterialLinkView = ExperimentMaterialLink & {
  title: string;
  currentRevision: number | null;
  archived: boolean;
  item?: any;
};
export type ExperimentOverview = {
  nodeId: string;
  revision: number;
  runs: ExperimentRunOverview[];
  materialLinks: ExperimentMaterialLinkView[];
};

export function RemoveRunDialog({
  run,
  links,
  en,
  revision,
  onConfirm,
  onClose,
}: {
  run: ExperimentRunOverview;
  links: ExperimentMaterialLinkView[];
  en: boolean;
  revision: number;
  onConfirm: (alsoRemoveLinks: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const blocked = run.records.length > 0;
  return (
    <ResearchDialog title={en ? "Remove run" : "删除运行"} onClose={onClose}>
      <div className="research-form">
        <p>
          {en
            ? `Remove “${run.label}” from this experiment.`
            : `将“${run.label}”从此实验中删除。`}
        </p>
        {links.length > 0 && (
          <p className="research-hint">
            {en
              ? `${links.length} material association(s) point to this run and will be removed with it.`
              : `${links.length} 项材料关联指向这次运行，将随运行一起移除。`}
          </p>
        )}
        {blocked && (
          <p role="alert">
            {en
              ? `${run.records.length} record block(s) still reference this run. Remove the run from those blocks first.`
              : `${run.records.length} 个记录块仍引用这次运行，请先在对应内容块中移除。`}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" className="button" onClick={onClose}>
            {en ? "Cancel" : "取消"}
          </button>
          <button
            type="button"
            className="button danger"
            disabled={saving || blocked}
            onClick={async () => {
              setSaving(true);
              setError("");
              try {
                await onConfirm(true);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? (en ? "Removing…" : "删除中…") : en ? "Remove run" : "删除运行"}
          </button>
        </footer>
        <span className="visually-hidden">{`revision ${revision}`}</span>
      </div>
    </ResearchDialog>
  );
}

export function RunEditor({
  run,
  en,
  revision,
  onSave,
  onClose,
}: {
  run?: ExperimentRun;
  en: boolean;
  revision: number;
  onSave: (value: object, revision: number) => Promise<void>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(run?.label ?? ""),
    [status, setStatus] = useState(run?.status ?? "unknown"),
    [note, setNote] = useState(run?.note ?? ""),
    [observed] = useState(revision),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  return (
    <ResearchDialog title={run ? (en ? "Edit run" : "编辑运行") : en ? "Add run" : "添加运行"} onClose={onClose}>
      <form
        className="research-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setError("");
          try {
            await onSave({ label, status, note }, observed);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        }}
      >
        <label>
          {en ? "Run name" : "运行名称"}
          <input required value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label>
          {en ? "Status" : "状态"}
          <SelectMenu
            ariaLabel={en ? "Run status" : "运行状态"}
            value={status}
            onChange={(value) => setStatus(value as typeof status)}
            options={Object.keys(statuses).map((value) => ({ value, label: runStatusLabel(value, en) }))}
          />
        </label>
        <label>
          {en ? "Notes" : "备注"}
          <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        {error && (
          <p role="alert">
            {error}
            <button type="button" className="button" onClick={onClose}>
              {en ? "Reload latest content" : "载入最新内容"}
            </button>
          </p>
        )}
        <footer>
          <button type="button" className="button" onClick={onClose}>
            {en ? "Cancel" : "取消"}
          </button>
          <button className="button primary" disabled={saving}>
            {saving ? (en ? "Saving…" : "保存中…") : en ? "Save" : "保存"}
          </button>
        </footer>
      </form>
    </ResearchDialog>
  );
}

export function MaterialEditor({
  run,
  blocks,
  en,
  revision,
  onSave,
  onClose,
}: {
  run: ExperimentRun;
  blocks: ContentBlock[];
  en: boolean;
  revision: number;
  onSave: (value: object, revision: number) => Promise<void>;
  onClose: () => void;
}) {
  const [materials] = useState(blocks.filter((block) => block.type !== "experimentRecord"));
  const [blockId, setBlockId] = useState(materials[0]?.id ?? ""),
    [target, setTarget] = useState("block"),
    [row, setRow] = useState(1),
    [observed] = useState(revision),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const block = materials.find((block) => block.id === blockId);
  const [assetRow, setAssetRow] = useState<Extract<MaterialSelection, { kind: "assetRow" }> | null>(null),
    [assetRowReady, setAssetRowReady] = useState(false);
  const fileRepresentations = (block?.representations ?? []).filter((rep) => rep.kind === "asset");
  const files = useQueries({
    queries: fileRepresentations.map((rep) => ({
      queryKey: ["research-asset", projectId(), rep.assetId],
      queryFn: () => api<any>("/api/research-assets/" + encodeURIComponent(rep.assetId)),
    })),
  });
  const options = [
    { value: "block", label: en ? "Whole block" : "整个内容块" },
    ...(block?.representations ?? [])
      .filter((rep) => rep.kind === "asset")
      .map((rep) => ({ value: "asset:" + rep.assetId, label: rep.label ?? rep.assetId })),
    ...(block?.type === "table" && block.payload?.rows?.length
      ? [{ value: "row", label: en ? "Table row" : "表格中的一行" }]
      : []),
    ...fileRepresentations
      .filter((rep, index) => /\.(xlsx|csv|tex)$/i.test(files[index]?.data?.asset?.originalName ?? rep.label ?? ""))
      .map((rep) => ({
        value: "assetRow:" + rep.assetId,
        label: (en ? "File table row: " : "文件表格行：") + (rep.label ?? rep.assetId),
      })),
  ];
  return (
    <ResearchDialog title={en ? "Link run material" : "关联运行材料"} onClose={onClose}>
      <form
        className="research-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!block) return;
          if (target.startsWith("assetRow:") && (!assetRow || !assetRowReady)) return;
          setSaving(true);
          setError("");
          try {
            const selection: MaterialSelection =
              target.startsWith("assetRow:") && assetRow
                ? assetRow
                : target === "row"
                  ? { kind: "row", rowIndex: row - 1 }
                  : target.startsWith("asset:")
                    ? { kind: "asset", assetId: target.slice(6) }
                    : { kind: "block" };
            await onSave({ runId: run.id, blockId: block.id, blockRevision: block.revision, selection }, observed);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        }}
      >
        <p>{run.label}</p>
        <label>
          {en ? "Material" : "研究材料"}
          <SelectMenu
            ariaLabel={en ? "Material" : "研究材料"}
            value={blockId}
            onChange={(value) => {
              setBlockId(value);
              setTarget("block");
              setRow(1);
              setAssetRow(null);
              setAssetRowReady(false);
            }}
            options={materials.map((block) => ({ value: block.id, label: block.title }))}
          />
        </label>
        <label>
          {en ? "Material item" : "材料中的具体项"}
          <SelectMenu
            ariaLabel={en ? "Material item" : "材料中的具体项"}
            value={target}
            onChange={(value) => {
              setTarget(value);
              setAssetRowReady(false);
              setAssetRow(
                value.startsWith("assetRow:")
                  ? { kind: "assetRow", assetId: value.slice("assetRow:".length), rowIndex: 1 }
                  : null,
              );
            }}
            options={options}
          />
        </label>
        {target === "row" && (
          <>
            <label>
              {en ? "Row number" : "行号"}
              <input
                type="number"
                required
                min={1}
                max={block?.payload?.rows?.length}
                value={row}
                onChange={(event) => setRow(Number(event.target.value))}
              />
            </label>
            <div className="research-table-wrap">
              <table className="research-table">
                <tbody>
                  {Object.entries(block?.payload?.rows?.[row - 1] ?? {})
                    .slice(0, 12)
                    .map(([key, value]) => (
                      <tr key={key}>
                        <th>{block?.payload.columns.find((column: any) => column.key === key)?.label ?? key}</th>
                        <td>{String(value ?? "")}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {target.startsWith("assetRow:") && assetRow && (
          <AssetTableRowFields selection={assetRow} en={en} onChange={setAssetRow} onReady={setAssetRowReady} />
        )}
        {error && (
          <p role="alert">
            {error}
            <button type="button" className="button" onClick={onClose}>
              {en ? "Reload latest content" : "载入最新内容"}
            </button>
          </p>
        )}
        <footer>
          <button type="button" className="button" onClick={onClose}>
            {en ? "Cancel" : "取消"}
          </button>
          <button
            className="button primary"
            disabled={saving || !block || (target.startsWith("assetRow:") && !assetRowReady)}
          >
            {saving ? (en ? "Linking…" : "关联中…") : en ? "Link" : "关联"}
          </button>
        </footer>
      </form>
    </ResearchDialog>
  );
}

export function MaterialVersionViewer({
  nodeId,
  link,
  en,
  onClose,
}: {
  nodeId: string;
  link: ExperimentMaterialLinkView;
  en: boolean;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["material-version", projectId(), nodeId, link.blockId, link.blockRevision],
    queryFn: () =>
      api<ContentBlock>(
        "/api/research-objects/node/" +
          encodeURIComponent(nodeId) +
          "/content-blocks/" +
          encodeURIComponent(link.blockId) +
          "?revision=" +
          link.blockRevision,
      ),
  });
  const [page, setPage] = useState(0);
  const block = query.data;
  const selected = link.selection;
  const representation =
    selected.kind === "asset" ? block?.representations?.find((rep) => rep.assetId === selected.assetId) : undefined;
  const tableRows =
    selected.kind === "row" ? [block?.payload?.rows?.[selected.rowIndex]].filter(Boolean) : (block?.payload?.rows ?? []);
  return (
    <ResearchDialog title={link.title || (en ? "Material" : "研究材料")} onClose={onClose}>
      <div className="experiment-material-version">
        <span className="research-badge">v{link.blockRevision}</span>
        {link.currentRevision !== null && link.currentRevision !== link.blockRevision && (
          <span className="research-hint">
            {en
              ? `The block has since moved to v${link.currentRevision}; this view keeps v${link.blockRevision}.`
              : `内容块现已更新到 v${link.currentRevision}，此处保留 v${link.blockRevision} 的关联内容。`}
          </span>
        )}
      </div>
      {query.isPending && <LoadingSkeleton layout="rows" label={en ? "Reading material version…" : "正在读取材料版本…"} />}
      {query.error && <p role="alert">{query.error.message}</p>}
      {block && selected.kind === "assetRow" && <AssetTableRowView selection={selected} en={en} expanded />}
      {block &&
        selected.kind !== "assetRow" &&
        (block.type === "table" && block.payload?.columns && selected.kind !== "asset" ? (
          <>
            <div className="research-table-wrap">
              <table className="research-table">
                <thead>
                  <tr>
                    {block.payload.columns.map((column: any) => (
                      <th key={column.key}>{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableRows.slice(page * 40, page * 40 + 40).map((row: any, index: number) => (
                    <tr key={index}>
                      {block.payload.columns.map((column: any) => (
                        <td key={column.key}>{String(row[column.key] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {tableRows.length > 40 && (
              <div className="research-pagination">
                <button className="button" disabled={!page} onClick={() => setPage(page - 1)}>
                  {en ? "Previous" : "上一页"}
                </button>
                <button className="button" disabled={(page + 1) * 40 >= tableRows.length} onClick={() => setPage(page + 1)}>
                  {en ? "Next" : "下一页"}
                </button>
              </div>
            )}
          </>
        ) : (
          <ContentBlockRenderer
            block={representation ? { ...block, primaryRepresentationId: representation.id } : block}
            owner={{ kind: "node", id: nodeId }}
            en={en}
          />
        ))}
    </ResearchDialog>
  );
}
