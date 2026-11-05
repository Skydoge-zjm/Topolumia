import {
  BadgeCheck, BookMarked, CircleAlert, Eye, FileText, FlaskConical, GitBranch, GitFork,
  HelpCircle, Lightbulb, ListChecks, Scale,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Node kinds are grouped into five research families. The family drives one accent hue,
 * so the canvas reads as "what kind of move is this object in the argument" instead of
 * thirteen competing colours. The icon keeps each kind individually recognisable.
 */
export type NodeFamily = "inquiry" | "evidence" | "reasoning" | "empirical" | "direction";

type Visual = { family: NodeFamily; icon: LucideIcon };

const visuals: Record<string, Visual> = {
  question: { family: "inquiry", icon: HelpCircle },
  assumption: { family: "inquiry", icon: Scale },
  hypothesis: { family: "inquiry", icon: Lightbulb },
  alternativeHypothesis: { family: "inquiry", icon: GitFork },
  paper: { family: "evidence", icon: FileText },
  readingNote: { family: "evidence", icon: BookMarked },
  observation: { family: "empirical", icon: Eye },
  experiment: { family: "empirical", icon: FlaskConical },
  inference: { family: "reasoning", icon: GitBranch },
  claim: { family: "reasoning", icon: BadgeCheck },
  decision: { family: "direction", icon: ListChecks },
  gap: { family: "direction", icon: CircleAlert },
  nextAction: { family: "direction", icon: GitBranch },
};

/** Ordered for adjacent use (stacked bars, legends); validated for colour-vision deficiency. */
export const FAMILY_ORDER: NodeFamily[] = ["inquiry", "evidence", "empirical", "reasoning", "direction"];

const FAMILY_COLORS: Record<NodeFamily, string> = {
  inquiry: "#0a7d55",
  evidence: "#a16207",
  empirical: "#2563eb",
  reasoning: "#a21caf",
  direction: "#c2410c",
};

export const familyColor = (family: string) => FAMILY_COLORS[family as NodeFamily] ?? "#31594c";

export const familyLabels: Record<NodeFamily, [string, string]> = {
  inquiry: ["问题与假说", "Questions & hypotheses"],
  evidence: ["文献与笔记", "Literature & notes"],
  empirical: ["实验与观察", "Experiments & observations"],
  reasoning: ["推论与结论", "Inferences & claims"],
  direction: ["决策与行动", "Decisions & actions"],
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
