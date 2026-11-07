export const researchNodeKinds = ["paper", "experiment", "note"] as const;
export type ResearchNodeKind = typeof researchNodeKinds[number];

// Existing scientific records keep their identity and content when read under
// the unified model. New writes are validated against researchNodeKinds only.
const existingScientificKinds = new Set([
  "question", "readingNote", "assumption", "hypothesis", "alternativeHypothesis",
  "observation", "inference", "claim", "decision", "gap", "nextAction",
]);
export function storedResearchNodeKind(kind: string): ResearchNodeKind | undefined {
  if (researchNodeKinds.includes(kind as ResearchNodeKind)) return kind as ResearchNodeKind;
  return existingScientificKinds.has(kind) ? "note" : undefined;
}
