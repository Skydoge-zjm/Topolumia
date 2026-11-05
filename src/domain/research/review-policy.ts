export type ReviewDecision = "accept" | "reject" | "defer";
export function reviewPermission(
  decision: ReviewDecision,
): "research.applyChange" | "research.review" {
  return decision === "accept" ? "research.applyChange" : "research.review";
}
