import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";
import { CodeView } from "./CodeView";

const PAGE_CHARS = 8000;

/** Reads a text file in bounded pages, so a long log never loads whole. */
export function AssetTextPreview({ assetId, checksum, filename, en }: { assetId: string; checksum?: string; filename?: string; en: boolean }) {
  const [offset, setOffset] = useState(0), [previous, setPrevious] = useState<number[]>([]);
  const query = useQuery({
    queryKey: ["research-asset-text", projectId(), assetId, checksum, offset],
    placeholderData: (data) => data,
    queryFn: () =>
      api<any>("/api/research/assets/" + encodeURIComponent(assetId) + "/read", {
        method: "POST",
        body: JSON.stringify({ view: "text", expectedChecksum: checksum, selection: { offset, length: PAGE_CHARS }, maxChars: 16000 }),
      }),
  });
  const data = query.data?.data, paged = data && (data.range.nextOffset !== null || previous.length > 0);
  return (
    <div className="asset-text-preview">
      {query.isPending && <p role="status" className="research-hint">{en ? "Reading file…" : "正在读取文件…"}</p>}
      {query.error && <p role="alert">{query.error.message}<button className="button" onClick={() => void query.refetch()}>{en ? "Retry" : "重试"}</button></p>}
      {data && <>
        {/* Line numbers are only known from the start of the file. */}
        <CodeView code={data.text} filename={filename} en={en} lineNumbers={data.range.start === 0} collapsible={!paged} />
        {paged && <div className="asset-text-pages">
          <span className="count">{data.range.start + 1}–{data.range.end} / {data.range.availableChars} {en ? "characters" : "字符"}</span>
          <button className="button" disabled={!previous.length || query.isFetching} onClick={() => { setOffset(previous.at(-1)!); setPrevious((current) => current.slice(0, -1)); }}>{en ? "Previous" : "上一页"}</button>
          <button className="button" disabled={data.range.nextOffset === null || query.isFetching} onClick={() => { setPrevious((current) => [...current, offset]); setOffset(data.range.nextOffset); }}>{en ? "Next" : "下一页"}</button>
        </div>}
      </>}
    </div>
  );
}
