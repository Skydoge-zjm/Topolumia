import { useState } from "react";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Link2, Trash2, ChartLine } from "lucide-react";
import { api, projectId } from "@/shared/lib/api";
import { ResearchDialog } from "@/features/research/components/ResearchUi";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import { LoadingSkeleton } from "@/shared/ui/LoadingSkeleton";
import {
  ContentBlockRenderer,
  type ContentBlock,
} from "@/features/topology/details/ContentBlockRenderer";
import { ExperimentCompareDialog } from "./ExperimentCompareDialog";
import { AssetTableRowFields, AssetTableRowView } from "./AssetTableRows";
import type {
  ExperimentRun,
  ExperimentMaterialLink,
  MaterialSelection,
} from "@domain/research/experiment-records";
import "./experiment-records.css";

type Overview = {
  nodeId: string;
  revision: number;
  runs: (ExperimentRun & { records: any[] })[];
  materialLinks: (ExperimentMaterialLink & {
    title: string;
    currentRevision: number | null;
    archived: boolean;
    item?: any;
  })[];
};
import { runStatusNames as statuses, runStatusLabel } from "./runPresentation";

export function ExperimentRunsPanel({
  nodeId,
  blocks,
  en,
  canEdit,
  onChanged,
}: {
  nodeId: string;
  blocks: ContentBlock[];
  en: boolean;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [viewMaterial, setViewMaterial] = useState<
    Overview["materialLinks"][number] | null
  >(null);
  const client = useQueryClient(),
    [selected, setSelected] = useState<string[]>([]),
    [compare, setCompare] = useState(false),
    [editor, setEditor] = useState<ExperimentRun | "new" | null>(null),
    [linkRun, setLinkRun] = useState<string | null>(null),
    [error, setError] = useState(""),
    [page, setPage] = useState(0);
  const query = useQuery({
    queryKey: ["experiment-runs", projectId(), nodeId],
    queryFn: () =>
      api<Overview>(
        "/api/research-nodes/" + encodeURIComponent(nodeId) + "/experiment",
      ),
  });
  const save = async (
    patch: object,
    expectedRevision = query.data!.revision,
  ) => {
    const result = await api<Overview>(
      "/api/research-nodes/" + encodeURIComponent(nodeId) + "/experiment",
      {
        method: "PATCH",
        body: JSON.stringify({
          expectedExperimentRevision: expectedRevision,
          patch,
        }),
      },
    );
    client.setQueryData(["experiment-runs", projectId(), nodeId], result);
    void client.invalidateQueries({
      queryKey: ["research-experiments", projectId()],
    });
    onChanged();
  };
  if (query.isPending)
    return (
      <LoadingSkeleton
        layout="rows"
        label={en ? "Loading runs…" : "正在读取运行记录…"}
      />
    );
  if (!query.data)
    return (
      <p role="alert">
        {query.error?.message}
        <button className="button" onClick={() => void query.refetch()}>
          {en ? "Retry" : "重试"}
        </button>
      </p>
    );
  const data = query.data,
    visible = data.runs.slice(page * 20, page * 20 + 20);
  return (
    <section className="experiment-records-panel" translate="no">
      <div className="experiment-run-toolbar">
        {canEdit && (
          <button className="button" onClick={() => setEditor("new")}>
            <Plus size={15} />
            {en ? "Add run" : "添加运行"}
          </button>
        )}
        <button className="button" onClick={() => setCompare(true)}>
          <ChartLine size={15} />
          {en ? "Compare runs" : "比较运行"}
          {selected.length > 0 && ` (${selected.length})`}
        </button>
        <span>
          {data.runs.length} {en ? "runs" : "次运行"}
        </span>
      </div>
      {(error || query.error) && (
        <p role="alert">
          {error || query.error?.message}
          <button
            className="button"
            onClick={() => {
              setError("");
              void query.refetch();
            }}
          >
            {en ? "Reload" : "载入最新内容"}
          </button>
        </p>
      )}
      <div className="research-table-wrap">
        <table className="research-table experiment-run-table">
          <thead>
            <tr>
              {(en
                ? ["Select", "Run", "Status", "Source", "Materials", "Actions"]
                : ["选择", "运行", "状态", "来源", "材料", "操作"]
              ).map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((run) => (
              <tr key={run.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={(en ? "Select " : "选择 ") + run.label}
                    checked={selected.includes(run.id)}
                    disabled={
                      !selected.includes(run.id) && selected.length >= 24
                    }
                    onChange={() =>
                      setSelected((current) =>
                        current.includes(run.id)
                          ? current.filter((id) => id !== run.id)
                          : [...current, run.id],
                      )
                    }
                  />
                </td>
                <td>
                  {run.label}
                  {run.note && <p>{run.note}</p>}
                </td>
                <td>{runStatusLabel(run.status, en)}</td>
                <td>
                  {[
                    ...new Set(
                      run.sources.map((source) =>
                        source.provider === "wandb"
                          ? "W&B"
                          : source.provider === "tensorboard"
                            ? "TensorBoard"
                            : source.provider,
                      ),
                    ),
                  ].join(" · ") || (en ? "Recorded" : "手工记录")}
                </td>
                <td>
                  {run.records.length +
                    data.materialLinks.filter((link) => link.runId === run.id)
                      .length}
                </td>
                <td>
                  {canEdit && (
                    <div className="research-actions">
                      <button
                        className="research-icon-button"
                        aria-label={(en ? "Edit " : "编辑 ") + run.label}
                        onClick={() => setEditor(run)}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        className="button"
                        onClick={() => setLinkRun(run.id)}
                      >
                        <Link2 size={15} />
                        {en ? "Link material" : "关联材料"}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data.runs.length && (
        <p className="research-empty">
          {en ? "No runs recorded." : "尚无运行记录。"}
        </p>
      )}
      {data.runs.length > 20 && (
        <div className="research-pagination">
          <button
            className="button"
            disabled={!page}
            onClick={() => setPage(page - 1)}
          >
            {en ? "Previous" : "上一页"}
          </button>
          <span>
            {page + 1} / {Math.ceil(data.runs.length / 20)}
          </span>
          <button
            className="button"
            disabled={(page + 1) * 20 >= data.runs.length}
            onClick={() => setPage(page + 1)}
          >
            {en ? "Next" : "下一页"}
          </button>
        </div>
      )}
      {data.materialLinks.length > 0 && (
        <section>
          <h2>{en ? "Material associations" : "材料关联"}</h2>
          <div className="research-table-wrap">
            <table className="research-table">
              <thead>
                <tr>
                  {(en
                    ? ["Run", "Material", "Item", "Version", "Actions"]
                    : ["运行", "材料", "具体项", "版本", "操作"]
                  ).map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.materialLinks.map((link) => (
                  <tr key={link.id}>
                    <td>
                      {data.runs.find((run) => run.id === link.runId)?.label}
                    </td>
                    <td>
                      <button
                        className="button"
                        onClick={() => setViewMaterial(link)}
                      >
                        {link.title}
                      </button>
                      {link.archived && (
                        <span className="research-badge">
                          {en ? "Archived" : "已归档"}
                        </span>
                      )}
                    </td>
                    <td>
                      {link.selection.kind === "row" ||
                      link.selection.kind === "assetRow"
                        ? (en ? "Row " : "第 ") +
                          (link.selection.rowIndex + 1) +
                          (en ? "" : " 行")
                        : link.selection.kind === "asset"
                          ? (link.item?.label ?? (en ? "File" : "文件"))
                          : en
                            ? "Block"
                            : "内容块"}
                    </td>
                    <td>v{link.blockRevision}</td>
                    <td>
                      {canEdit && (
                        <button
                          className="research-icon-button"
                          aria-label={
                            (en ? "Unlink " : "解除关联 ") + link.title
                          }
                          onClick={() => {
                            void save({ removeLinkIds: [link.id] }).catch(
                              (cause) => setError(cause.message),
                            );
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {editor && (
        <RunEditor
          run={editor === "new" ? undefined : editor}
          en={en}
          revision={data.revision}
          onClose={() => {
            setEditor(null);
            void query.refetch();
          }}
          onSave={async (value, revision) => {
            await save(
              editor === "new"
                ? { addRuns: [value] }
                : { updateRuns: [{ ...value, id: editor.id }] },
              revision,
            );
            setEditor(null);
          }}
        />
      )}
      {linkRun && (
        <MaterialEditor
          run={data.runs.find((run) => run.id === linkRun)!}
          blocks={blocks}
          en={en}
          revision={data.revision}
          onClose={() => {
            setLinkRun(null);
            void query.refetch();
          }}
          onSave={async (value, revision) => {
            await save({ addLinks: [value] }, revision);
            setLinkRun(null);
          }}
        />
      )}
      {viewMaterial && (
        <MaterialVersionViewer
          nodeId={nodeId}
          link={viewMaterial}
          en={en}
          onClose={() => setViewMaterial(null)}
        />
      )}
      {compare && (
        <ExperimentCompareDialog
          en={en}
          initial={selected.map((runId) => ({ nodeId, runId }))}
          onClose={() => setCompare(false)}
        />
      )}
    </section>
  );
}

function RunEditor({
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
    <ResearchDialog
      title={run ? (en ? "Edit run" : "编辑运行") : en ? "Add run" : "添加运行"}
      onClose={onClose}
    >
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
          <input
            required
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label>
          {en ? "Status" : "状态"}
          <SelectMenu
            ariaLabel={en ? "Run status" : "运行状态"}
            value={status}
            onChange={(value) => setStatus(value as typeof status)}
            options={Object.keys(statuses).map((value) => ({
              value,
              label: runStatusLabel(value, en),
            }))}
          />
        </label>
        <label>
          {en ? "Notes" : "备注"}
          <textarea
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
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
            {en ? "Save" : "保存"}
          </button>
        </footer>
      </form>
    </ResearchDialog>
  );
}

function MaterialEditor({
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
  const [materials] = useState(
    blocks.filter((block) => block.type !== "experimentRecord"),
  );
  const [blockId, setBlockId] = useState(materials[0]?.id ?? ""),
    [target, setTarget] = useState("block"),
    [row, setRow] = useState(1),
    [observed] = useState(revision),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const block = materials.find((block) => block.id === blockId);
  const [assetRow, setAssetRow] = useState<Extract<
      MaterialSelection,
      { kind: "assetRow" }
    > | null>(null),
    [assetRowReady, setAssetRowReady] = useState(false);
  const fileRepresentations = (block?.representations ?? []).filter(
    (rep) => rep.kind === "asset",
  );
  const files = useQueries({
    queries: fileRepresentations.map((rep) => ({
      queryKey: ["research-asset", projectId(), rep.assetId],
      queryFn: () =>
        api<any>("/api/research-assets/" + encodeURIComponent(rep.assetId)),
    })),
  });
  const options = [
    { value: "block", label: en ? "Whole block" : "整个内容块" },
    ...(block?.representations ?? [])
      .filter((rep) => rep.kind === "asset")
      .map((rep) => ({
        value: "asset:" + rep.assetId,
        label: rep.label ?? rep.assetId,
      })),
    ...(block?.type === "table" && block.payload?.rows?.length
      ? [{ value: "row", label: en ? "Table row" : "表格中的一行" }]
      : []),
    ...fileRepresentations
      .filter((rep, index) =>
        /\.(xlsx|csv|tex)$/i.test(
          files[index]?.data?.asset?.originalName ?? rep.label ?? "",
        ),
      )
      .map((rep) => ({
        value: "assetRow:" + rep.assetId,
        label:
          (en ? "File table row: " : "文件表格行：") +
          (rep.label ?? rep.assetId),
      })),
  ];
  return (
    <ResearchDialog
      title={en ? "Link run material" : "关联运行材料"}
      onClose={onClose}
    >
      <form
        className="research-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!block) return;
          if (target.startsWith("assetRow:") && (!assetRow || !assetRowReady))
            return;
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
            await onSave(
              {
                runId: run.id,
                blockId: block.id,
                blockRevision: block.revision,
                selection,
              },
              observed,
            );
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
            options={materials.map((block) => ({
              value: block.id,
              label: block.title,
            }))}
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
                  ? {
                      kind: "assetRow",
                      assetId: value.slice("assetRow:".length),
                      rowIndex: 1,
                    }
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
                        <th>
                          {block?.payload.columns.find(
                            (column: any) => column.key === key,
                          )?.label ?? key}
                        </th>
                        <td>{String(value ?? "")}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {target.startsWith("assetRow:") && assetRow && (
          <AssetTableRowFields
            selection={assetRow}
            en={en}
            onChange={setAssetRow}
            onReady={setAssetRowReady}
          />
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
            disabled={
              saving ||
              !block ||
              (target.startsWith("assetRow:") && !assetRowReady)
            }
          >
            {en ? "Link" : "关联"}
          </button>
        </footer>
      </form>
    </ResearchDialog>
  );
}

function MaterialVersionViewer({
  nodeId,
  link,
  en,
  onClose,
}: {
  nodeId: string;
  link: Overview["materialLinks"][number];
  en: boolean;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: [
      "material-version",
      projectId(),
      nodeId,
      link.blockId,
      link.blockRevision,
    ],
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
    selected.kind === "asset"
      ? block?.representations?.find((rep) => rep.assetId === selected.assetId)
      : undefined;
  const tableRows =
    selected.kind === "row"
      ? [block?.payload?.rows?.[selected.rowIndex]].filter(Boolean)
      : (block?.payload?.rows ?? []);
  return (
    <ResearchDialog
      title={link.title || (en ? "Material" : "研究材料")}
      onClose={onClose}
    >
      <span className="research-badge">v{link.blockRevision}</span>
      {query.isPending && (
        <LoadingSkeleton
          layout="rows"
          label={en ? "Reading material version…" : "正在读取材料版本…"}
        />
      )}
      {query.error && <p role="alert">{query.error.message}</p>}
      {block && selected.kind === "assetRow" && (
        <AssetTableRowView selection={selected} en={en} expanded />
      )}
      {block &&
        selected.kind !== "assetRow" &&
        (block.type === "table" &&
        block.payload?.columns &&
        selected.kind !== "asset" ? (
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
                  {tableRows
                    .slice(page * 40, page * 40 + 40)
                    .map((row: any, index: number) => (
                      <tr key={index}>
                        {block.payload.columns.map((column: any) => (
                          <td key={column.key}>
                            {String(row[column.key] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {tableRows.length > 40 && (
              <div className="research-pagination">
                <button
                  className="button"
                  disabled={!page}
                  onClick={() => setPage(page - 1)}
                >
                  {en ? "Previous" : "上一页"}
                </button>
                <button
                  className="button"
                  disabled={(page + 1) * 40 >= tableRows.length}
                  onClick={() => setPage(page + 1)}
                >
                  {en ? "Next" : "下一页"}
                </button>
              </div>
            )}
          </>
        ) : (
          <ContentBlockRenderer
            block={
              representation
                ? { ...block, primaryRepresentationId: representation.id }
                : block
            }
            owner={{ kind: "node", id: nodeId }}
            en={en}
          />
        ))}
    </ResearchDialog>
  );
}
