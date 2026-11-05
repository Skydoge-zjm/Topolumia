import { useMemo, useState } from "react";
import type { AgentEvent } from "@/shared/types/api";
import { traceDetail } from "@/features/agents/trace/agentTrace";
import { copyText } from "@/shared/lib/copyText";
import { decodeToolOutput } from "@/features/agents/tools/toolOutput";
import {
  topolumiaOperation,
  toolInvocation,
} from "@/features/agents/tools/agentTool";
import { StructuredToolOutput, StructuredValue } from "./StructuredToolOutput";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");

function Output({
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
  const [full, setFull] = useState(false),
    [copied, setCopied] = useState(false),
    [feedback, setFeedback] = useState("");
  const content = useMemo(() => text(value), [value]),
    decoded = useMemo(() => decodeToolOutput(value), [value]);
  const visible = typeof decoded.value === "string" ? decoded.value : content;
  return (
    <div className="tool-output-view">
      <div className="output-toolbar">
        <span>{en ? "Output" : "输出"}</span>
        <button
          type="button"
          onClick={() =>
            void copyText(content).then(
              () => {
                setCopied(true);
                setFeedback("");
              },
              (error) => setFeedback(error.message),
            )
          }
        >
          {copied
            ? en
              ? "Copied"
              : "已复制"
            : en
              ? "Copy output"
              : "复制输出"}
        </button>
      </div>
      <div
        className={`tool-content-scroll${decoded.structured ? " structured-tool-output" : ""}`}
        tabIndex={0}
        role="region"
        aria-label={en ? "Tool output" : "工具输出"}
        onClick={(event) => {
          const target = event.target as HTMLElement,
            code = target.closest("[data-code-copy]");
          if (code)
            void copyText(
              code.closest(".code-block")?.querySelector("code")?.textContent ??
                "",
            ).then(
              () => setFeedback(en ? "Code copied" : "代码已复制"),
              (error) => setFeedback(error.message),
            );
          const ref =
            target.closest<HTMLElement>("[data-source-ref]")?.dataset.sourceRef;
          if (ref) onSource?.(ref);
        }}
      >
        {decoded.structured ? (
          <StructuredToolOutput
            value={decoded.value}
            en={en}
            research={research}
            onSource={onSource}
          />
        ) : (
          <pre className="tool-output trace-final-output" translate="no">
            {full ? visible : visible.slice(0, 20_000)}
          </pre>
        )}
      </div>
      {!decoded.structured && !full && visible.length > 20_000 && (
        <button type="button" className="button" onClick={() => setFull(true)}>
          {en
            ? `Show all ${visible.length.toLocaleString()} characters`
            : `显示全部 ${visible.length.toLocaleString()} 字符`}
        </button>
      )}
      {feedback && (
        <p className="tool-output-feedback" role="status">
          {feedback}
        </p>
      )}
    </div>
  );
}

export function ToolResult({
  event,
  en,
  onSource,
}: {
  event: AgentEvent;
  en: boolean;
  onSource?: (ref: string, version?: string) => void;
}) {
  const p = event.payload,
    item = record(p.item);
  const { command, input } = toolInvocation(event);
  const changes = (item.changes ?? p.changes) as
    Array<{ path?: string; diff?: string }> | undefined;
  const output =
    p.rawOutput ??
    item.aggregatedOutput ??
    item.output ??
    item.result ??
    p.result;
  const research = Boolean(topolumiaOperation({ events: [event] }));
  const details = traceDetail(event);
  return (
    <div className="tool-detail tool-result-view" translate="no">
      {command !== undefined && (
        <>
          <div className="tool-section-label">{en ? "Command" : "命令"}</div>
          <pre
            className="tool-command tool-content-scroll"
            tabIndex={0}
            role="region"
            aria-label={en ? "Full command" : "完整命令"}
          >
            {text(command)}
          </pre>
          <dl className="tool-facts">
            {(item.cwd ?? p.cwd) !== undefined && (
              <>
                <dt>{en ? "Directory" : "目录"}</dt>
                <dd>{text(item.cwd ?? p.cwd)}</dd>
              </>
            )}
            {item.exitCode !== undefined && (
              <>
                <dt>{en ? "Exit code" : "退出码"}</dt>
                <dd>{text(item.exitCode)}</dd>
              </>
            )}
          </dl>
        </>
      )}
      {command === undefined && input !== undefined && (
        <section className="tool-input-view">
          <div className="tool-section-label">{en ? "Input" : "调用参数"}</div>
          <div
            className="tool-content-scroll"
            tabIndex={0}
            role="region"
            aria-label={en ? "Tool input" : "工具输入"}
          >
            <StructuredValue value={decodeToolOutput(input).value} en={en} />
          </div>
        </section>
      )}
      {Array.isArray(changes) &&
        changes.map((change, i) => (
          <div className="file-diff" key={i}>
            <strong>{change.path}</strong>
            <pre className="tool-content-scroll" tabIndex={0}>
              {String(change.diff ?? "")
                .split("\n")
                .map((line, index) => (
                  <span
                    key={index}
                    className={
                      line.startsWith("+")
                        ? "diff-added"
                        : line.startsWith("-")
                          ? "diff-removed"
                          : ""
                    }
                  >
                    {line}
                    {"\n"}
                  </span>
                ))}
            </pre>
          </div>
        ))}
      {output !== undefined ? (
        <Output
          value={output}
          en={en}
          research={research}
          onSource={onSource}
        />
      ) : !command && !changes?.length ? (
        <Output
          value={details || (en ? "No additional output." : "无额外输出。")}
          en={en}
          research={research}
          onSource={onSource}
        />
      ) : null}
      {!research &&
        command === undefined &&
        (changes?.length || output !== undefined) && (
          <details className="raw-tool-details">
            <summary>{en ? "Full operation details" : "完整操作详情"}</summary>
            <Output value={details} en={en} />
          </details>
        )}
    </div>
  );
}
