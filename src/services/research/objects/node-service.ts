import { coreSchema } from "../../../domain/research/content-blocks.js";
import { fail } from "../../../domain/research/access.js";
import { nodeRef } from "../../../domain/research/object-ref.js";
import { isResearchNodeKind } from "../../topology/topology-service.js";
import { storedResearchNodeKind } from "../../../domain/research/node-kinds.js";
const localized = value => typeof value === "string" ? value : value?.zh ?? value?.en ?? "";
export class NodeObjectService {
  constructor(commands) { this.commands = commands; this.store = commands.store; }
  node(id) {
    const object = this.store.get("nodes", id);
    if (object?.deleted) fail("RESEARCH_NODE_NOT_FOUND", "Research node not found.", 404);
    if (object) return { ...object, kind: storedResearchNodeKind(object.kind) ?? object.kind };
    const source = this.commands.formalTopology().nodes.find(node => node.id === id);
    if (!source) fail("RESEARCH_NODE_NOT_FOUND", "Research node not found.", 404);
    return this.identity(source);
  }
  identity(source) { return { id: source.id, kind: storedResearchNodeKind(source.kind) ?? source.kind, core: { nodeName: localized(source.label), ...(source.kind !== "paper" && localized(source.summary) ? { summary: localized(source.summary) } : {}) }, sourceRefs: [], revision: 1, coreRevision: 1, blockCollectionRevision: 1, relationRevision: 1,  status: source.status, createdAt: source.data?.createdAt ?? null }; }
  nodes() { const stored = new Map(this.store.all("nodes").map(node => [node.id, { ...node, kind: storedResearchNodeKind(node.kind) ?? node.kind }])); return this.commands.formalTopology().nodes.map(node => stored.get(node.id) ?? this.identity(node)).filter(node => !node.deleted); }
  blocks(id, archived = false) { return this.commands.objects.blocks(nodeRef(id), archived); }
  block(id, blockId) { return this.commands.objects.block(nodeRef(id), blockId); }
  core(input, kind) { if (!isResearchNodeKind(kind)) fail("NODE_KIND_INVALID", "Unsupported node kind."); const parsed = coreSchema(kind).safeParse(input); if (!parsed.success) fail("NODE_CORE_INVALID", "Invalid node core.", 422, parsed.error.issues.slice(0, 6)); return parsed.data; }
  project(node, topology) {
    const existing = topology.nodes.find(item => item.id === node.id), label = node.core.nodeName;
    const summary = node.kind === "paper" ? (node.core.abstract ?? "").slice(0, 500) : node.core.summary ?? "";
    const projected = { ...(existing ?? { id: node.id, code: node.kind.toUpperCase(), position: { x: 300, y: 300 }, tags: [], sourceRef: null }), kind: node.kind, label: { zh: label, en: label }, summary: { zh: summary, en: summary }, status: node.status ?? "active", data: { ...(existing?.data ?? {}), researchRevision: node.revision } };
    for (const key of ["core", "contentBlocks", "assets", "legacyContentPreserved", "details", "body", "noteMarkdown"]) delete projected.data[key];
    return projected;
  }
  detail(id) { return this.commands.objects.detail(nodeRef(id)); }
}
