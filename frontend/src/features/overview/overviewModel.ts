import { FAMILY_ORDER, nodeVisual, type NodeFamily } from "@/features/topology/model/nodeVisuals";
import type { Group, ResearchNode, ResearchRecord } from "@/features/research/model";
import type { ResearchRelation } from "@/features/topology/details/RelationEditor";

export type Topology = { nodes: ResearchNode[]; edges: ResearchRelation[]; groups: Group[] };

const EVIDENCE_TYPES = new Set(["supports", "contradicts", "tested_by", "compared_against"]);

/** Node counts per research family, plus the containers and links around them. */
export function researchStructure(topology: Topology) {
  const families = Object.fromEntries(FAMILY_ORDER.map(family => [family, 0])) as Record<NodeFamily, number>;
  for (const node of topology.nodes) families[nodeVisual(node.kind).family] += 1;
  return { families, nodes: topology.nodes.length, groups: topology.groups.length, relations: topology.edges.length };
}

const endpoint = (ref: ResearchRelation["from"]) => (ref.kind === "node" ? ref.id : `group:${ref.id}`);

/**
 * Argument health from the formal graph only. Each ratio has an explicit denominator
 * so an empty project reads as "nothing to measure" instead of a fabricated score.
 */
export function argumentHealth(topology: Topology) {
  const touching = new Map<string, ResearchRelation[]>();
  for (const edge of topology.edges)
    for (const id of [endpoint(edge.from), endpoint(edge.to)]) {
      if (!touching.has(id)) touching.set(id, []);
      touching.get(id)!.push(edge);
    }
  const grouped = new Set(topology.groups.flatMap(group => group.members.map(member => member.nodeId)));
  const of = (kinds: string[]) => topology.nodes.filter(node => kinds.includes(node.kind));
  const hypotheses = of(["hypothesis", "alternativeHypothesis"]);
  const claims = of(["claim", "inference"]);
  const tested = hypotheses.filter(node => (touching.get(node.id) ?? []).some(edge => EVIDENCE_TYPES.has(edge.type)));
  const supported = claims.filter(node =>
    (touching.get(node.id) ?? []).some(edge => edge.type === "supports" && endpoint(edge.to) === node.id),
  );
  const contested = topology.nodes.filter(node =>
    (touching.get(node.id) ?? []).some(edge => edge.type === "contradicts"),
  );
  const isolated = topology.nodes.filter(node => !touching.has(node.id) && !grouped.has(node.id));
  return {
    hypotheses: { done: tested.length, total: hypotheses.length },
    claims: { done: supported.length, total: claims.length },
    connected: { done: topology.nodes.length - isolated.length, total: topology.nodes.length },
    contested: contested.map(node => node.id),
    isolated: isolated.map(node => node.id),
  };
}

export type OpenAction = { recordId: string; recordTitle: string; text: string; assignee: string; dueDate: string | null };

/** Open follow-ups from records, overdue first, then by due date, undated last. */
export function openActions(records: ResearchRecord[], today = new Date().toISOString().slice(0, 10)) {
  const items: (OpenAction & { overdue: boolean })[] = [];
  for (const record of records)
    for (const action of record.actions ?? [])
      if (action.status === "open")
        items.push({ recordId: record.id, recordTitle: record.title, text: action.text, assignee: action.assignee, dueDate: action.dueDate, overdue: Boolean(action.dueDate && action.dueDate < today) });
  return items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
}

/** Planned activities that have not happened yet, soonest first. */
export function upcoming(records: ResearchRecord[], now = Date.now()) {
  return records
    .filter(record => record.status === "planned" && record.scheduledAt && Date.parse(record.scheduledAt) >= now - 3_600_000)
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
}

export const ratio = ({ done, total }: { done: number; total: number }) => (total ? Math.round((done / total) * 100) : null);
