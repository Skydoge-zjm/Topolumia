import { describe, expect, it } from "vitest";
import type { ResearchRecord } from "@/features/research/model";
import { argumentHealth, openActions, ratio, researchStructure, upcoming, type Topology } from "./overviewModel";

const node = (id: string, kind: string) => ({ id, kind, label: id, summary: "", status: "active" });
const edge = (id: string, from: string, to: string, type: string) => ({ id, from: { kind: "node" as const, id: from }, to: { kind: "node" as const, id: to }, type, revision: 1 });
const graph: Topology = {
  nodes: [node("q", "question"), node("h1", "hypothesis"), node("h2", "hypothesis"), node("e", "experiment"), node("c", "claim"), node("o", "observation"), node("lone", "paper")],
  edges: [edge("r1", "e", "h1", "tested_by"), edge("r2", "o", "c", "supports"), edge("r3", "o", "h2", "contradicts"), edge("r4", "q", "h1", "informs")],
  groups: [],
};

describe("overview derivations", () => {
  it("counts objects by research family", () => {
    const structure = researchStructure(graph);
    expect(structure).toMatchObject({ nodes: 7, groups: 0, relations: 4 });
    expect(structure.families).toEqual({ inquiry: 3, evidence: 1, empirical: 2, reasoning: 1, direction: 0 });
  });

  it("measures argument coverage from formal relations only", () => {
    const health = argumentHealth(graph);
    expect(health.hypotheses).toEqual({ done: 2, total: 2 });
    expect(health.claims).toEqual({ done: 1, total: 1 });
    expect(health.contested.sort()).toEqual(["h2", "o"]);
    expect(health.isolated).toEqual(["lone"]);
    expect(health.connected).toEqual({ done: 6, total: 7 });
  });

  it("treats a claim as supported only when support points at it", () => {
    const reversed = { ...graph, edges: [edge("r", "c", "o", "supports")] };
    expect(argumentHealth(reversed).claims.done).toBe(0);
  });

  it("counts group membership as connected", () => {
    const grouped = { ...graph, groups: [{ id: "g", core: { nodeName: "G" }, parentId: null, members: [{ nodeId: "lone" }], primaryRelations: {}, revision: 1, membershipRevision: 1, relationRevision: 1 }] };
    expect(argumentHealth(grouped).isolated).toEqual([]);
  });

  it("reports no ratio for an empty denominator", () => {
    expect(ratio({ done: 0, total: 0 })).toBeNull();
    expect(ratio({ done: 1, total: 3 })).toBe(33);
  });

  it("orders open actions overdue first, then by due date", () => {
    const record = (id: string, actions: ResearchRecord["actions"]) => ({ id, title: id, actions }) as ResearchRecord;
    const items = openActions([
      record("a", [{ text: "later", assignee: "", dueDate: "2026-12-01", status: "open" }, { text: "done", assignee: "", dueDate: "2026-01-01", status: "done" }]),
      record("b", [{ text: "undated", assignee: "", dueDate: null, status: "open" }, { text: "late", assignee: "", dueDate: "2026-10-01", status: "open" }]),
    ], "2026-11-05");
    expect(items.map(item => item.text)).toEqual(["late", "later", "undated"]);
    expect(items[0].overdue).toBe(true);
  });

  it("lists only future planned activities, soonest first", () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    const record = (id: string, status: string, scheduledAt: string | null) => ({ id, status, scheduledAt }) as ResearchRecord;
    const items = upcoming([record("past", "planned", "2026-11-01T09:00:00Z"), record("late", "planned", "2026-11-20T09:00:00Z"), record("soon", "planned", "2026-11-06T09:00:00Z"), record("draft", "draft", "2026-11-07T09:00:00Z")], now);
    expect(items.map(item => item.id)).toEqual(["soon", "late"]);
  });
});
