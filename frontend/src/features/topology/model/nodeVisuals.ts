import { BookMarked, FileText, FlaskConical, Layers } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { nodeKinds } from "@domain/research/node-fields";

/**
 * Each object type uses its own icon and a stable accent family.
 */
export type NodeFamily = "evidence" | "reasoning" | "empirical";

type Visual = { family: NodeFamily; icon: LucideIcon };

const visuals: Record<string, Visual> = {
  paper: { family: "evidence", icon: FileText },
  experiment: { family: "empirical", icon: FlaskConical },
  note: { family: "reasoning", icon: BookMarked },
};

/** Ordered for adjacent use (stacked bars, legends); validated for colour-vision deficiency. */
export const FAMILY_ORDER: NodeFamily[] = ["evidence", "empirical", "reasoning"];

/** Mirrors tokens.css --kind-*; SVG and canvas need resolved colours. */
const FAMILY_COLORS: Record<NodeFamily, string> = {
  evidence: "#9a6b14",
  empirical: "#2f5fd0",
  reasoning: "#8e3a8c",
};
const GROUP_COLOR = "#178d70";

export const familyColor = (family: string) => FAMILY_COLORS[family as NodeFamily] ?? "#31594c";

export const familyLabels: Record<NodeFamily, [string, string]> = {
  evidence: ["文献", "Literature"],
  empirical: ["实验", "Experiments"],
  reasoning: ["研究笔记", "Research notes"],
};

export function nodeVisual(kind: string): Visual {
  return visuals[kind] ?? { family: "reasoning", icon: FileText };
}

/** The three node kinds in the order they are listed everywhere in the workspace. */
export const NODE_KIND_ORDER = ["paper", "experiment", "note"] as const;

export const kindColor = (kind: string) => kind === "group" ? GROUP_COLOR : FAMILY_COLORS[nodeVisual(kind).family];
export const kindIcon = (kind: string): LucideIcon => kind === "group" ? Layers : nodeVisual(kind).icon;
export const kindLabel = (kind: string, en: boolean) =>
  kind === "group" ? (en ? "Node group" : "节点组") : (en ? nodeKinds[kind]?.en : nodeKinds[kind]?.label) ?? kind;

/** Number of characters a label contributes to an SVG chip, keeping CJK roughly twice as wide. */
export function chipWidth(label: string, padding = 12, perChar = 6.2, wide = 11) {
  let units = 0;
  for (const char of label) units += /[⺀-鿿豈-﫿＀-￯]/.test(char) ? wide : perChar;
  return Math.max(34, units + padding);
}
