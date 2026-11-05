import { useState } from "react";
import { renderMarkdown } from "@/shared/lib/markdown";
import { outputRecord } from "@/features/agents/tools/toolOutput";

const fieldNames: Record<string, [string, string]> = {
  id: ["标识", "ID"],
  name: ["名称", "Name"],
  label: ["名称", "Name"],
  title: ["标题", "Title"],
  kind: ["类型", "Kind"],
  type: ["类型", "Type"],
  status: ["状态", "Status"],
  summary: ["摘要", "Summary"],
  ref: ["来源", "Source"],
  sourceRefs: ["相关来源", "Sources"],
  source: ["来源", "Source"],
  text: ["正文", "Text"],
  facts: ["数据", "Data"],
  reason: ["说明", "Reason"],
  query: ["检索词", "Query"],
  nodes: ["节点", "Nodes"],
  relations: ["关系", "Relations"],
  sources: ["来源", "Sources"],
  pendingCandidates: ["待审阅变更", "Pending changes"],
  candidateId: ["待审阅变更", "Proposed change"],
  blockCount: ["内容块数", "Content blocks"],
  researchContent: ["研究成果构成", "Research content inventory"],
  blockTypes: ["内容类型", "Content types"],
  imageAssets: ["图像附件数", "Image assets"],
  textChars: ["正文字符数", "Text characters"],
  notice: ["交付说明", "Delivery note"],
  blocks: ["内容块", "Content blocks"],
  blockId: ["内容块标识", "Block ID"],
  formalChangesApplied: ["已应用到正式节点", "Applied to formal research"],
  omittedNodes: ["其余节点数", "Additional nodes"],
  omittedBlocks: ["其余内容块数", "Additional blocks"],
  capabilities: ["可用内容", "Available content"],
  textAvailable: ["可读取正文", "Text available"],
  valuesAvailable: ["可读取数值", "Values available"],
  originalAvailable: ["可读取原文件", "Original available"],
  nativeReadHint: ["原文件阅读方式", "Read original file"],
  downloadHint: ["文件获取方式", "Download file"],
  readHint: ["继续读取", "Continue reading"],
  availableNames: ["支持的格式", "Supported formats"],
  idempotencyKey: ["请求恢复标识", "Request recovery key"],
  scope: ["数据范围", "Scope"],
  byKind: ["类型分布", "By kind"],
  project: ["项目", "Project"],
  projectId: ["项目", "Project ID"],
  version: ["版本", "Version"],
  schemaVersion: ["数据格式", "Schema"],
  stateVersion: ["研究版本", "Research version"],
  sourceStateVersion: ["来源集合版本", "Source collection version"],
  sourceVersion: ["来源版本", "Source version"],
  range: ["读取范围", "Read range"],
  start: ["起始字符", "Start character"],
  end: ["结束字符", "End character"],
  totalChars: ["总字符数", "Total characters"],
  availableChars: ["可读字符数", "Available characters"],
  nextOffset: ["下一段起点", "Next offset"],
  completeContentAvailable: ["完整内容可读", "Complete content available"],
  disclosure: ["内容范围", "Content coverage"],
  limitations: ["内容限制", "Limitations"],
  contentAvailability: ["可用内容", "Content availability"],
  items: ["条目", "Items"],
  total: ["总数", "Total"],
  nextCursor: ["后续页标识", "Next-page cursor"],
  budget: ["返回范围", "Response budget"],
  truncated: ["还有后续内容", "More content available"],
  maxChars: ["字符预算", "Character budget"],
  returnedChars: ["返回字符数", "Returned characters"],
  counts: ["统计", "Counts"],
  questions: ["研究问题", "Research questions"],
  freshness: ["更新情况", "Freshness"],
  lastCheckedAt: ["最后检查", "Last checked"],
  operations: ["变更内容", "Changes"],
  operationCount: ["操作数", "Operations"],
  revision: ["修订", "Revision"],
  evidenceReads: ["证据读取", "Evidence reads"],
  readReceipt: ["读取凭据", "Read receipt"],
  evidence: ["证据", "Evidence"],
  from: ["起点", "From"],
  to: ["终点", "To"],
  neighbor: ["关联节点", "Related node"],
  relation: ["关系", "Relation"],
  op: ["操作", "Operation"],
  node: ["节点", "Node"],
  nodeId: ["节点", "Node ID"],
  patch: ["修改字段", "Updated fields"],
  createdBy: ["创建者", "Created by"],
  provenance: ["记录来源", "Provenance"],
  observedAt: ["观测时间", "Observed at"],
  provider: ["来源类型", "Provider"],
  path: ["路径", "Path"],
  value: ["数值", "Value"],
  error: ["错误", "Error"],
  code: ["代码", "Code"],
  message: ["说明", "Message"],
};
const fieldLabel = (key: string, en: boolean) =>
  fieldNames[key]?.[en ? 1 : 0] ?? key;
const localized = (value: unknown, en: boolean): string => {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  const item = outputRecord(value);
  return typeof item[en ? "en" : "zh"] === "string"
    ? String(item[en ? "en" : "zh"])
    : typeof item.zh === "string"
      ? item.zh
      : typeof item.en === "string"
        ? item.en
        : "";
};
const isRecord = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const scalar = (value: unknown) => value === null || typeof value !== "object";

function LongText({ value, en }: { value: string; en: boolean }) {
  const [full, setFull] = useState(false);
  return (
    <span className="structured-text">
      {full ? value : value.slice(0, 1800)}
      {!full && value.length > 1800 && (
        <button className="structured-more" onClick={() => setFull(true)}>
          {en
            ? `Show all ${value.length} characters`
            : `展开全文（${value.length} 字符）`}
        </button>
      )}
    </span>
  );
}
function DeferredValue({ value, en }: { value: unknown; en: boolean }) {
  const [open, setOpen] = useState(false),
    size = Array.isArray(value)
      ? value.length
      : Object.keys(outputRecord(value)).length;
  return (
    <details
      className="structured-nested"
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setOpen(event.currentTarget.open);
      }}
    >
      <summary>
        {en
          ? `${size} ${Array.isArray(value) ? "items" : "fields"}`
          : `${size} ${Array.isArray(value) ? "项内容" : "个字段"}`}
      </summary>
      {open && <StructuredValue value={value} en={en} />}
    </details>
  );
}

export function StructuredValue({
  value,
  en,
  depth = 0,
}: {
  value: unknown;
  en: boolean;
  depth?: number;
}) {
  const [shown, setShown] = useState(20);
  if (value === null || value === undefined)
    return (
      <span className="structured-empty">
        {value === null ? (en ? "None" : "无") : "—"}
      </span>
    );
  if (typeof value === "boolean")
    return <span>{value ? (en ? "Yes" : "是") : en ? "No" : "否"}</span>;
  if (typeof value === "number") return <span>{String(value)}</span>;
  if (typeof value === "string") return <LongText value={value} en={en} />;
  if (depth >= 3) return <DeferredValue value={value} en={en} />;
  if (Array.isArray(value)) {
    if (!value.length)
      return (
        <span className="structured-empty">{en ? "No items" : "暂无条目"}</span>
      );
    const visible = value.slice(0, shown),
      table = value.every(
        (item) =>
          isRecord(item) && Object.values(outputRecord(item)).every(scalar),
      );
    const columns = table
      ? [
          ...new Set(
            visible.flatMap((item) => Object.keys(outputRecord(item))),
          ),
        ].slice(0, 6)
      : [];
    const extras =
      table &&
      visible.some((item) =>
        Object.keys(outputRecord(item)).some((key) => !columns.includes(key)),
      );
    return (
      <div className="structured-array">
        {table ? (
          <div className="structured-table-scroll">
            <table>
              <thead>
                <tr>
                  {columns.map((key) => (
                    <th key={key}>{fieldLabel(key, en)}</th>
                  ))}
                  {extras && <th>{en ? "Details" : "详情"}</th>}
                </tr>
              </thead>
              <tbody>
                {visible.map((item, i) => (
                  <tr key={i}>
                    {columns.map((key) => (
                      <td key={key}>
                        <StructuredValue
                          value={outputRecord(item)[key]}
                          en={en}
                          depth={depth + 1}
                        />
                      </td>
                    ))}
                    {extras && (
                      <td>
                        <DeferredValue
                          value={Object.fromEntries(
                            Object.entries(outputRecord(item)).filter(
                              ([key]) => !columns.includes(key),
                            ),
                          )}
                          en={en}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ol className="structured-list">
            {visible.map((item, i) => (
              <li key={i}>
                <StructuredValue value={item} en={en} depth={depth + 1} />
              </li>
            ))}
          </ol>
        )}
        {value.length > shown && (
          <button
            type="button"
            className="structured-more"
            onClick={() => setShown((count) => count + 20)}
          >
            {en
              ? `Show more (${shown}/${value.length})`
              : `显示更多（${shown}/${value.length}）`}
          </button>
        )}
      </div>
    );
  }
  const item = outputRecord(value),
    entries = Object.entries(item);
  if (
    entries.length &&
    entries.every(
      ([key, text]) => ["zh", "en"].includes(key) && typeof text === "string",
    )
  )
    return <LongText value={localized(item, en)} en={en} />;
  if (!entries.length)
    return (
      <span className="structured-empty">{en ? "No fields" : "暂无字段"}</span>
    );
  return (
    <div>
      <dl className="structured-fields">
        {entries.slice(0, shown).map(([key, text]) => (
          <div key={key}>
            <dt>{fieldLabel(key, en)}</dt>
            <dd>
              <StructuredValue value={text} en={en} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
      {entries.length > shown && (
        <button
          className="structured-more"
          onClick={() => setShown((count) => count + 20)}
        >
          {en
            ? `Show more (${shown}/${entries.length})`
            : `显示更多（${shown}/${entries.length}）`}
        </button>
      )}
    </div>
  );
}

function ExtraFields({
  item,
  consumed,
  en,
}: {
  item: Record<string, unknown>;
  consumed: string[];
  en: boolean;
}) {
  const extra = Object.fromEntries(
    Object.entries(item).filter(([key]) => !consumed.includes(key)),
  );
  return Object.keys(extra).length ? (
    <details className="research-result-metadata">
      <summary>{en ? "More information" : "更多信息"}</summary>
      <StructuredValue value={extra} en={en} />
    </details>
  ) : null;
}

function ResultItem({ value, en }: { value: unknown; en: boolean }) {
  const item = outputRecord(value),
    title = localized(
      item.label ??
        item.name ??
        item.reason ??
        item.title ??
        item.id ??
        item.ref,
      en,
    );
  if (!title) return <StructuredValue value={value} en={en} />;
  const states: Record<string, [string, string]> = {
    pending: ["待审阅", "Pending review"],
    deferred: ["已暂缓", "Deferred"],
    applied: ["已应用", "Applied"],
    rejected: ["已拒绝", "Rejected"],
    stale: ["需要更新", "Needs refresh"],
    active: ["有效", "Active"],
  };
  const state =
    typeof item.status === "string"
      ? (states[item.status]?.[en ? 1 : 0] ?? item.status)
      : "";
  return (
    <article className="research-result-item">
      <header>
        <strong>{title}</strong>
        {state && <span>{state}</span>}
      </header>
      {item.id !== undefined && item.id !== title && (
        <small>{String(item.id)}</small>
      )}
      {item.ref !== undefined && item.ref !== title && (
        <small>{String(item.ref)}</small>
      )}
      {localized(item.summary ?? item.snippet, en) && (
        <p>{localized(item.summary ?? item.snippet, en)}</p>
      )}
      {item.facts !== undefined && (
        <StructuredValue value={item.facts} en={en} />
      )}
      {Array.isArray(item.relations) && item.relations.length > 0 && (
        <section>
          <h5>{en ? "Relationships" : "节点关系"}</h5>
          <StructuredValue value={item.relations} en={en} />
        </section>
      )}
      {Array.isArray(item.sourceRefs) && item.sourceRefs.length > 0 && (
        <section>
          <h5>{en ? "Sources" : "相关来源"}</h5>
          <StructuredValue value={item.sourceRefs} en={en} />
        </section>
      )}
      <ExtraFields
        item={item}
        en={en}
        consumed={[
          "label",
          "name",
          "reason",
          "title",
          "id",
          "ref",
          "status",
          "summary",
          "snippet",
          "facts",
          "relations",
          "sourceRefs",
        ]}
      />
    </article>
  );
}

export function StructuredToolOutput({
  value,
  en,
  research = false,
  onSource,
}: {
  value: unknown;
  en: boolean;
  research?: boolean;
  onSource?: (ref: string, version?: string) => void;
}) {
  const [shown, setShown] = useState(20);
  const data =
    research &&
    Array.isArray(value) &&
    value.length === 1 &&
    typeof outputRecord(value[0]).schemaVersion === "string"
      ? value[0]
      : value;
  const item = outputRecord(data),
    schema = String(item.schemaVersion ?? "");
  if (!research || !/^(research-|topology-patch)/.test(schema))
    return <StructuredValue value={data} en={en} />;
  const source = outputRecord(item.source),
    project = outputRecord(item.project),
    range = outputRecord(item.range);
  if (Object.keys(source).length) {
    const title = localized(
        source.label ?? source.title ?? source.path ?? source.ref,
        en,
      ),
      ref = typeof source.ref === "string" ? source.ref : undefined;
    return (
      <article className="research-source-result">
        <header>
          <strong>{title || (en ? "Source content" : "来源内容")}</strong>
          {ref && onSource && (
            <button
              className="structured-more"
              onClick={() =>
                onSource(
                  ref,
                  typeof source.version === "string"
                    ? source.version
                    : undefined,
                )
              }
            >
              {en ? "Open source" : "查看来源"}
            </button>
          )}
        </header>
        {ref && ref !== title && (
          <div className="research-result-ref">{ref}</div>
        )}
        {typeof range.start === "number" && typeof range.end === "number" && (
          <p className="research-result-range">
            {en ? "Characters" : "字符范围"} {range.start}–{range.end}
            {typeof range.totalChars === "number" && ` / ${range.totalChars}`}
          </p>
        )}
        {typeof item.text === "string" ? (
          <div
            className="research-result-markdown message-body"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(item.text, { en }),
            }}
          />
        ) : (
          <StructuredValue
            value={item.facts ?? { disclosure: item.disclosure }}
            en={en}
          />
        )}
        {range.nextOffset != null && (
          <p className="research-result-notice">
            {en
              ? "This result is a source excerpt; more content is available."
              : "本次返回来源片段，后面还有内容。"}
          </p>
        )}
        <details className="research-result-metadata">
          <summary>{en ? "Source and version" : "来源与版本"}</summary>
          <StructuredValue
            value={{ ...source, ...(item.range ? { range: item.range } : {}) }}
            en={en}
          />
        </details>
        <ExtraFields
          item={item}
          en={en}
          consumed={["source", "text", "facts", "range"]}
        />
      </article>
    );
  }
  if (/research-brief/.test(schema))
    return (
      <article className="research-brief-result">
        <h4>
          {localized(project.name, en) ||
            (en ? "Research context" : "科研上下文")}
        </h4>
        <StructuredValue value={item.counts} en={en} />
        {Array.isArray(item.questions) && item.questions.length > 0 && (
          <section>
            <h5>{en ? "Research questions" : "研究问题"}</h5>
            {item.questions.map((entry, index) => (
              <ResultItem key={index} value={entry} en={en} />
            ))}
          </section>
        )}
        {Array.isArray(item.pendingCandidates) &&
          item.pendingCandidates.length > 0 && (
            <section>
              <h5>{en ? "Pending changes" : "待审阅变更"}</h5>
              {item.pendingCandidates.map((entry, index) => (
                <ResultItem key={index} value={entry} en={en} />
              ))}
            </section>
          )}
        <ExtraFields
          item={item}
          en={en}
          consumed={["counts", "questions", "pendingCandidates"]}
        />
      </article>
    );
  if (Array.isArray(item.items)) {
    const items = item.items;
    return (
      <section className="research-results">
        <header>
          <strong>
            {en
              ? `${items.length} returned${typeof item.total === "number" ? ` · ${item.total} total` : ""}`
              : `返回 ${items.length} 项${typeof item.total === "number" ? ` · 共 ${item.total} 项` : ""}`}
          </strong>
          {typeof item.query === "string" && <span>{item.query}</span>}
        </header>
        {items.length ? (
          items
            .slice(0, shown)
            .map((entry, index) => (
              <ResultItem key={index} value={entry} en={en} />
            ))
        ) : (
          <p className="structured-empty">{en ? "No results" : "暂无结果"}</p>
        )}
        {items.length > shown && (
          <button
            className="structured-more"
            onClick={() => setShown((count) => count + 20)}
          >
            {en ? "Show more" : "显示更多"}
          </button>
        )}
        {item.nextCursor != null && (
          <p className="research-result-notice">
            {en
              ? "Additional results are available on subsequent pages."
              : "后续页面还有结果。"}
          </p>
        )}
        <ExtraFields
          item={item}
          en={en}
          consumed={["items", "total", "query"]}
        />
      </section>
    );
  }
  return <StructuredValue value={data} en={en} />;
}
