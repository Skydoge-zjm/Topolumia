import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, projectId } from "@/shared/lib/api";

export function AssetTextPreview({
  assetId,
  checksum,
  en,
}: {
  assetId: string;
  checksum?: string;
  en: boolean;
}) {
  const [offset, setOffset] = useState(0),
    [previous, setPrevious] = useState<number[]>([]);
  const query = useQuery({
    queryKey: ["research-asset-text", projectId(), assetId, checksum, offset],
    queryFn: () =>
      api<any>(
        "/api/research/assets/" + encodeURIComponent(assetId) + "/read",
        {
          method: "POST",
          body: JSON.stringify({
            view: "text",
            expectedChecksum: checksum,
            selection: { offset, length: 8000 },
            maxChars: 16000,
          }),
        },
      ),
  });
  const data = query.data?.data;
  return (
    <div className="asset-text-preview">
      {query.isPending && (
        <p role="status">{en ? "Reading file…" : "正在读取文件…"}</p>
      )}
      {query.error && (
        <p role="alert">
          {query.error.message}
          <button className="button" onClick={() => void query.refetch()}>
            {en ? "Retry" : "重试"}
          </button>
        </p>
      )}
      {data && (
        <>
          <div className="asset-text-toolbar">
            <span className="research-hint">
              {data.range.start + 1}–{data.range.end} / {data.range.availableChars}
            </span>
            <button
              className="button"
              disabled={!navigator.clipboard}
              onClick={() => void navigator.clipboard?.writeText(data.text)}
            >
              {en ? "Copy range" : "复制本段"}
            </button>
          </div>
          <pre className="content-block-code">{data.text}</pre>
          {(data.range.nextOffset !== null || previous.length > 0) && (
            <div className="research-pagination">
              <button
                className="button"
                disabled={!previous.length}
                onClick={() => {
                  setOffset(previous.at(-1)!);
                  setPrevious((current) => current.slice(0, -1));
                }}
              >
                {en ? "Previous" : "上一页"}
              </button>
              <button
                className="button"
                disabled={data.range.nextOffset === null}
                onClick={() => {
                  setPrevious((current) => [...current, offset]);
                  setOffset(data.range.nextOffset);
                }}
              >
                {en ? "Next" : "下一页"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
