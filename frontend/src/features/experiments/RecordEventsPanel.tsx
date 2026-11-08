import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { SelectMenu } from "@/shared/ui/SelectMenu";

const names = {
  config: ["配置", "Config"],
  summary: ["摘要", "Summary"],
  table: ["表格", "Tables"],
  distribution: ["分布", "Distributions"],
  media: ["媒体", "Media"],
  file: ["原文件", "Files"],
  lifecycle: ["执行状态", "Lifecycle"],
  extension: ["扩展记录", "Extensions"],
};
export function RecordEventsPanel({
  blockId,
  en,
}: {
  blockId: string;
  en: boolean;
}) {
  const [kind, setKind] = useState("config"),
    [after, setAfter] = useState(0),
    [history, setHistory] = useState<number[]>([]);
  const query = useQuery<any>({
    queryKey: ["record-events", projectId(), blockId, kind, after],
    queryFn: ({ signal }) =>
      api(
        "/api/research/record-blocks/" +
          encodeURIComponent(blockId) +
          "/events?kind=" +
          kind +
          "&after=" +
          after +
          "&limit=20",
        { signal },
      ),
  });
  return (
    <div className="record-events-panel">
      <div className="experiment-run-toolbar">
        <SelectMenu
          ariaLabel={en ? "Record kind" : "记录类型"}
          value={kind}
          options={Object.entries(names).map(([value, labels]) => ({
            value,
            label: labels[en ? 1 : 0],
          }))}
          onChange={(value) => {
            setKind(value);
            setAfter(0);
            setHistory([]);
          }}
        />
        <button className="button" onClick={() => void query.refetch()}>
          {en ? "Refresh" : "刷新"}
        </button>
      </div>
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data?.items.map((item: any) => (
        <RecordEvent
          key={item.watermark}
          item={item}
          blockId={blockId}
          en={en}
        />
      ))}
      {query.data?.items.length === 0 && (
        <p className="research-empty">{en ? "No records" : "暂无记录"}</p>
      )}
      <div className="experiment-run-toolbar">
        <button
          className="button"
          disabled={!history.length}
          onClick={() => {
            setAfter(history.at(-1)!);
            setHistory((value) => value.slice(0, -1));
          }}
        >
          {en ? "Previous" : "上一页"}
        </button>
        <button
          className="button"
          disabled={!query.data?.nextAfter}
          onClick={() => {
            setHistory((value) => [...value, after]);
            setAfter(query.data.nextAfter);
          }}
        >
          {en ? "Next" : "下一页"}
        </button>
      </div>
    </div>
  );
}

function RecordEvent({
  item,
  blockId,
  en,
}: {
  item: any;
  blockId: string;
  en: boolean;
}) {
  const event = item.event,
    data = event.data ?? {},
    native = data.native ?? data;
  const refs = data.attachments ?? [];
  const buckets = native.buckets ?? native.values ?? [],
    labels = native.limits ?? native.bins ?? [];
  const download = (hash: string) =>
    "/api/research/record-blocks/" +
    encodeURIComponent(blockId) +
    "/attachments/" +
    hash +
    "?projectId=" +
    encodeURIComponent(projectId());
  const body = JSON.stringify(
    data.update ??
      (event.kind === "extension"
        ? {
            ...data,
            value:
              data.encoding === "protobuf-base64" ? "[protobuf]" : data.value,
          }
        : native),
    null,
    2,
  );
  return (
    <article className="record-event">
      <strong>{event.key ?? event.kind}</strong>
      <span className="research-badge">
        {event.sourceRunId} · #{item.watermark}
      </span>
      {event.kind === "distribution" && buckets.length > 0 ? (
        <div className="research-table-wrap">
          <table className="research-table">
            <thead>
              <tr>
                <th>{en ? "Bucket" : "区间"}</th>
                <th>{en ? "Count" : "数量"}</th>
              </tr>
            </thead>
            <tbody>
              {buckets.slice(0, 100).map((count: any, index: number) => (
                <tr key={index}>
                  <td>{String(labels[index] ?? index)}</td>
                  <td>{String(count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <pre className="content-block-code">
          {body.slice(0, 8000)}
          {body.length > 8000 ? "…" : ""}
        </pre>
      )}
      {refs.map((ref: any) => (
        <div key={ref.sha256}>
          <a className="button" href={download(ref.sha256)}>
            {ref.name ?? (en ? "Download" : "下载原文件")}
          </a>
          {event.kind === "table" && (
            <NativeTablePreview url={download(ref.sha256)} en={en} />
          )}
        </div>
      ))}
      {data.missingDependencies?.length > 0 && (
        <p role="status">
          {en ? "Missing files" : "缺少文件"}：
          {data.missingDependencies.join(", ")}
        </p>
      )}
    </article>
  );
}

function NativeTablePreview({ url, en }: { url: string; en: boolean }) {
  const [open, setOpen] = useState(false);
  const query = useQuery<any>({
    queryKey: ["record-table-preview", url],
    enabled: open,
    queryFn: async ({ signal }) => {
      const response = await fetch(url, { signal, credentials: "same-origin" });
      if (!response.ok)
        throw new Error(en ? "Attachment not received" : "附件尚未接收");
      if (Number(response.headers.get("content-length") ?? 0) > 1_048_576) {
        await response.body?.cancel();
        throw new Error(en ? "Download the full table" : "请下载完整表格");
      }
      const reader = response.body!.getReader();
      let text = "",
        size = 0;
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 1_048_576) {
          await reader.cancel();
          throw new Error(en ? "Download the full table" : "请下载完整表格");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text);
    },
  });
  return (
    <div>
      <button
        className="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open
          ? en
            ? "Close preview"
            : "关闭预览"
          : en
            ? "Preview table"
            : "预览表格"}
      </button>
      {open && query.error && <p role="alert">{query.error.message}</p>}
      {open && query.data?.columns && (
        <div className="research-table-wrap">
          <table className="research-table">
            <thead>
              <tr>
                {query.data.columns.slice(0, 12).map((column: string) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {query.data.data?.slice(0, 50).map((row: any[], i: number) => (
                <tr key={i}>
                  {row.slice(0, 12).map((value, j) => (
                    <td key={j}>
                      {typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
