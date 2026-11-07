import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { SelectMenu } from "@/shared/ui/SelectMenu";
import type { MaterialSelection } from "@domain/research/experiment-records";

type Selection = Extract<MaterialSelection, { kind: "assetRow" }>;
function useRow(selection: Selection) {
  return useQuery({
    enabled: Number.isInteger(selection.rowIndex) && selection.rowIndex >= 0,
    queryKey: [
      "asset-table-row",
      projectId(),
      selection.assetId,
      selection.sheet,
      selection.rowIndex,
    ],
    queryFn: () =>
      api<any>(
        "/api/research/assets/" +
          encodeURIComponent(selection.assetId) +
          "/read",
        {
          method: "POST",
          body: JSON.stringify({
            view: "values",
            selection: {
              sheet: selection.sheet,
              rowOffset: selection.rowIndex,
              rowLimit: 1,
            },
            maxChars: 16000,
          }),
        },
      ),
  });
}
function RowValues({ data }: { data: any }) {
  return (
    <div className="research-table-wrap">
      <table className="research-table">
        <thead>
          <tr>
            {data.columns.map((column: any) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.items.map((row: any) => (
            <tr key={row.index}>
              {data.columns.map((column: any) => (
                <td key={column.key}>{String(row.values[column.key] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AssetTableRowFields({
  selection,
  en,
  onChange,
  onReady,
}: {
  selection: Selection;
  en: boolean;
  onChange: (value: Selection) => void;
  onReady: (ready: boolean) => void;
}) {
  const meta = useQuery({
    queryKey: ["research-asset", projectId(), selection.assetId],
    queryFn: () =>
      api<any>("/api/research-assets/" + encodeURIComponent(selection.assetId)),
    refetchInterval: (query) =>
      query.state.data?.asset?.processing === "queued" ? 500 : false,
  });
  const query = useRow(selection),
    data = query.data?.data;
  const sheets: string[] =
    meta.data?.asset?.sheetNames ?? (data?.sheetName ? [data.sheetName] : []);
  useEffect(() => {
    onReady(Boolean(data?.items?.length) && !query.isFetching && !query.error);
  }, [data, query.isFetching, query.error, onReady]);
  useEffect(() => {
    if (selection.sheet === undefined && data?.sheetName)
      onChange({ ...selection, sheet: data.sheetName });
  }, [selection, data?.sheetName, onChange]);
  return (
    <>
      {sheets.length > 0 && (
        <label>
          {en ? "Worksheet" : "工作表"}
          <SelectMenu
            ariaLabel={en ? "Worksheet" : "工作表"}
            value={selection.sheet ?? data?.sheetName ?? sheets[0]}
            onChange={(sheet) => {
              onReady(false);
              onChange({ ...selection, sheet, rowIndex: 1 });
            }}
            options={sheets.map((value) => ({ value, label: value }))}
          />
        </label>
      )}
      <label>
        {en ? "File row number" : "文件中的行号"}
        <input
          type="number"
          min={1}
          max={data?.availableRows}
          required
          value={selection.rowIndex + 1}
          onChange={(event) => {
            onReady(false);
            onChange({
              ...selection,
              rowIndex: Number(event.target.value) - 1,
            });
          }}
        />
      </label>
      {query.isFetching && (
        <p role="status">{en ? "Reading worksheet…" : "正在读取表格…"}</p>
      )}
      {query.error && (
        <p role="alert">
          {query.error.message}
          <button
            type="button"
            className="button"
            onClick={() => void query.refetch()}
          >
            {en ? "Retry" : "重试"}
          </button>
        </p>
      )}
      {data && <RowValues data={data} />}
    </>
  );
}

function ReadOnlyRow({ selection, en }: { selection: Selection; en: boolean }) {
  const query = useRow(selection);
  return (
    <>
      {query.isFetching && (
        <p role="status">{en ? "Reading worksheet…" : "正在读取表格…"}</p>
      )}
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data && <RowValues data={query.data.data} />}
    </>
  );
}
export function AssetTableRowView({
  selection,
  en,
  expanded = false,
}: {
  selection: Selection;
  en: boolean;
  expanded?: boolean;
}) {
  const [open, setOpen] = useState(expanded);
  return expanded ? (
    <ReadOnlyRow selection={selection} en={en} />
  ) : (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{en ? "View associated row" : "查看关联行"}</summary>
      {open && <ReadOnlyRow selection={selection} en={en} />}
    </details>
  );
}
