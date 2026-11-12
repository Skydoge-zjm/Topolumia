import { AssetTableRowView } from "./AssetTableRows";
import { useState } from "react";
import type {
  ExperimentRun,
  ExperimentMaterialLink,
} from "@domain/research/experiment-records";
import { runStatusLabel } from "./runPresentation";

export function ExperimentMetadataSnapshot({
  runs = [],
  links = [],
  materials = [],
  en,
}: {
  runs?: ExperimentRun[];
  links?: ExperimentMaterialLink[];
  materials?: {
    id?: string;
    blockId: string;
    blockRevision: number;
    title?: string;
    item?: { label?: string };
  }[];
  en: boolean;
}) {
  const [limit, setLimit] = useState(50);
  return (
    <div className="experiment-metadata-snapshot">
      <span className="research-badge">
        {runs.length} {en ? "runs" : "次运行"} · {links.length}{" "}
        {en ? "associations" : "项材料关联"}
      </span>
      {runs.length > 0 && (
        <>
          <h4>{en ? "Run records" : "运行记录"}</h4>
          <div className="research-table-wrap">
            <table className="research-table">
              <thead>
                <tr>
                  <th>{en ? "Run" : "运行"}</th>
                  <th>{en ? "Status" : "状态"}</th>
                  <th>{en ? "Source" : "来源"}</th>
                  <th>{en ? "Notes" : "备注"}</th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, limit).map((run) => (
                  <tr key={run.id}>
                    <td>{run.label}</td>
                    <td>{runStatusLabel(run.status, en)}</td>
                    <td>
                      {run.sources
                        ?.map(
                          (source) => source.provider + ": " + source.sourceId,
                        )
                        .join(" · ") || "—"}
                    </td>
                    <td>{run.note || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {links.length > 0 && (
        <>
          <h4>{en ? "Material associations" : "材料关联"}</h4>
          <div className="research-table-wrap">
            <table className="research-table">
              <thead>
                <tr>
                  <th>{en ? "Run" : "运行"}</th>
                  <th>{en ? "Material" : "材料"}</th>
                  <th>{en ? "Version" : "版本"}</th>
                  <th>{en ? "Item" : "具体项"}</th>
                </tr>
              </thead>
              <tbody>
                {links.slice(0, limit).map((link) => (
                  <tr key={link.id}>
                    <td>
                      {runs.find((run) => run.id === link.runId)?.label ??
                        link.runId}
                    </td>
                    <td>
                      {materials.find(
                        (item) =>
                          item.blockId === link.blockId &&
                          item.blockRevision === link.blockRevision,
                      )?.title ?? link.blockId}
                    </td>
                    <td>v{link.blockRevision}</td>
                    <td>
                      {link.selection.kind === "row" ||
                      link.selection.kind === "assetRow"
                        ? (en ? "Row " : "第 ") +
                          (link.selection.rowIndex + 1) +
                          (en ? "" : " 行")
                        : link.selection.kind === "asset"
                          ? (materials.find((item) => item.id === link.id)?.item
                              ?.label ?? link.selection.assetId)
                          : en
                            ? "Block"
                            : "内容块"}
                      {link.selection.kind === "assetRow" && (
                        <AssetTableRowView selection={link.selection} en={en} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {Math.max(runs.length, links.length) > limit && (
        <button className="button" onClick={() => setLimit(limit + 50)}>
          {en ? "Show more" : "查看更多"}
        </button>
      )}
    </div>
  );
}
