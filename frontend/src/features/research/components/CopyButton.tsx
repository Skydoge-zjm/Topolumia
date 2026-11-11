import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/shared/lib/copyText";

/** Copies on click and confirms in place; a failed copy says so instead of pretending. */
export function CopyButton({ text, en, label, className = "" }: { text: string | (() => string); en: boolean; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle"), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const name = label ?? (en ? "Copy" : "复制");
  return (
    <button
      type="button"
      className={"copy-button " + className}
      onClick={async () => {
        try { await copyText(typeof text === "function" ? text() : text); setState("copied"); }
        catch { setState("failed"); }
        clearTimeout(timer.current); timer.current = setTimeout(() => setState("idle"), 1600);
      }}
    >
      {state === "copied" ? <Check size={13} /> : <Copy size={13} />}
      <span aria-live="polite">{state === "copied" ? (en ? "Copied" : "已复制") : state === "failed" ? (en ? "Copy failed" : "复制失败") : name}</span>
    </button>
  );
}
