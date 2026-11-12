import { useMemo, useState } from "react";
import { CopyButton } from "@/features/research/components/CopyButton";
import { codeLanguage, highlightCode } from "@/shared/lib/markdown";

const COLLAPSED_LINES = 24;

/** A listing that reads as code: fixed pitch, line numbers, highlighting where the language is known. */
export function CodeView({ code, language, filename, en, lineNumbers = true, collapsible = true }: {
  code: string; language?: string; filename?: string; en: boolean; lineNumbers?: boolean; collapsible?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => code.replace(/\n$/, "").split("\n"), [code]);
  const long = collapsible && lines.length > COLLAPSED_LINES + 6, shown = long && !open ? lines.slice(0, COLLAPSED_LINES) : lines;
  const resolved = codeLanguage(language, filename);
  const html = useMemo(() => highlightCode(shown.join("\n"), resolved), [shown, resolved]);
  const label = filename || language || "";
  return (
    <div className="code-view" translate="no">
      <div className="code-view-bar">
        <span className="code-view-name">{label}</span>
        <span className="count">{lines.length} {en ? "lines" : "行"}</span>
        <CopyButton text={code} en={en} />
      </div>
      <div className="code-view-scroll">
        {lineNumbers && <pre className="code-view-gutter" aria-hidden="true">{shown.map((_, index) => index + 1).join("\n")}</pre>}
        <pre className="code-view-code content-block-code"><code dangerouslySetInnerHTML={{ __html: html || " " }} /></pre>
      </div>
      {long && <button type="button" className="code-view-more" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? (en ? "Show fewer lines" : "收起") : (en ? `Show all ${lines.length} lines` : `展开全部 ${lines.length} 行`)}
      </button>}
    </div>
  );
}
