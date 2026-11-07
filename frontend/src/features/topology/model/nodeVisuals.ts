import {
  BookMarked, FileText, FlaskConical,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

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

const FAMILY_COLORS: Record<NodeFamily, string> = {
  evidence: "#a16207",
  empirical: "#2563eb",
  reasoning: "#a21caf",
};

export const familyColor = (family: string) => FAMILY_COLORS[family as NodeFamily] ?? "#31594c";

export const familyLabels: Record<NodeFamily, [string, string]> = {
  evidence: ["文献", "Literature"],
  empirical: ["实验", "Experiments"],
  reasoning: ["研究笔记", "Research notes"],
};

export function nodeVisual(kind: string): Visual {
  return visuals[kind] ?? { family: "reasoning", icon: FileText };
}

/** Number of characters a label contributes to an SVG chip, keeping CJK roughly twice as wide. */
export function chipWidth(label: string, padding = 12, perChar = 6.2, wide = 11) {
  let units = 0;
  for (const char of label) units += /[⺀-鿿豈-﫿＀-￯]/.test(char) ? wide : perChar;
  return Math.max(34, units + padding);
}
