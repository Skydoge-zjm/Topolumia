import { randomUUID } from "node:crypto";
import { contentBlockInput, extractContentBlockText, validateContentBlockPayload } from "../../../domain/research/content-blocks.js";
import { sameObject, objectKey } from "../../../domain/research/object-ref.js";
import { objectRefSchema } from "../../../domain/research/object-schemas.js";
import { fail, actorIdentity } from "../../../domain/research/access.js";

export class ResearchObjectService {
  constructor(commands) { this.c = commands; this.store = commands.store; }
  get(owner) { const parsed = objectRefSchema.safeParse(owner); if (!parsed.success) fail("OBJECT_REF_INVALID", "Supply a node/group object reference."); const ref = parsed.data; return ref.kind === "group" ? this.c.groups.get(ref.id) : this.c.nodes.node(ref.id); }
  from(view, owner) { if (!objectRefSchema.safeParse(owner).success) fail("OBJECT_REF_INVALID", "Supply a node/group object reference."); return view[owner.kind === "group" ? "groups" : "nodes"].find(item => item.id === owner.id && !item.deleted) ?? fail("RESEARCH_OBJECT_NOT_FOUND", "Research object not found.", 404); }
  blocks(owner, archived = false) { this.get(owner); return this.store.blocksForOwner(owner).filter(block => archived || block.lifecycle !== "archived").sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)); }
  block(owner, id) { this.get(owner); const block = this.store.get("blocks", id); if (!block || !sameObject(block.owner, owner) || block.lifecycle === "archived") fail("CONTENT_BLOCK_NOT_FOUND", "Content block not found.", 404); return block; }
  blockVersion(owner, id, revision) { this.get(owner); if (!Number.isInteger(revision) || revision < 1) fail("INPUT_INVALID", "Invalid material revision.", 422); const block = this.store.get("versions", id + ":" + revision); if (!block || block.id !== id || !sameObject(block.owner, owner)) fail("CONTENT_BLOCK_NOT_FOUND", "Material version not found.", 404); return block; }
  sources(values = [], actor) { return values.map(source => { const { clientRef, delivery: _delivery, ...rest } = source; return { ...rest, id: source.id ?? "source:" + randomUUID(), delivery: actor.isAgent ? "agentReported" : "humanRecorded", ...(clientRef ? { clientRef } : {}) }; }); }
  validateBlock(input, actor) {
    const parsed = contentBlockInput.safeParse(input);
    if (!parsed.success) fail("CONTENT_BLOCK_INVALID", "Invalid block.", 422, parsed.error.issues.slice(0, 6));
    const value = parsed.data;
    if (value.role === "body" && value.type !== "richText") fail("CONTENT_BLOCK_INVALID", "A note body must be rich text.");
    if (actor.isAgent && ["confirmed", "rejected"].includes(value.review)) fail("REVIEW_REQUIRES_USER", "Only humans confirm scientific content.", 403);
    if (value.payload !== undefined) { const checked = validateContentBlockPayload(value.type, value.payload); if (!checked.success) fail("CONTENT_BLOCK_PAYLOAD_INVALID", "Invalid content payload.", 422, checked.issues); value.payload = checked.data; }
    const representationOnly = ["table", "image", "document", "spreadsheet", "link", "file"].includes(value.type);
    if (!value.payload && (!representationOnly || !value.representations.length)) fail("CONTENT_BLOCK_EMPTY", "Provide content or a supported representation.");
    if (["image", "document", "spreadsheet", "file"].includes(value.type) && !value.representations.some(rep => rep.kind === "asset")) fail("CONTENT_BLOCK_ASSET_REQUIRED", "A file representation is required.");
    if (value.primaryRepresentationId && !value.representations.some(rep => rep.id === value.primaryRepresentationId || "@" + rep.clientRef === value.primaryRepresentationId)) fail("REPRESENTATION_NOT_FOUND", "Invalid primary representation.");
    value.sourceRefs = this.sources(value.sourceRefs, actor);
    const mapping = new Map(value.sourceRefs.filter(source => source.clientRef).map(source => ["@" + source.clientRef, source.id]));
    value.sourceRefs = value.sourceRefs.map(({ clientRef: _ref, ...source }) => source);
    const sourceIds = new Set(value.sourceRefs.map(source => source.id));
    const resolveSource = id => { const resolved = mapping.get(id) ?? id; if (!sourceIds.has(resolved)) fail("SOURCE_REF_NOT_FOUND", "Source reference must belong to the block."); return resolved; };
    value.representations = value.representations.map(rep => { const { clientRef, ...rest } = rep; return { ...rest, id: rep.id ?? "representation:" + randomUUID(), ...(rep.sourceRefIds ? { sourceRefIds: rep.sourceRefIds.map(resolveSource) } : {}), _clientRef: clientRef }; });
    if (value.primaryRepresentationId?.startsWith("@")) value.primaryRepresentationId = value.representations.find(rep => "@" + rep._clientRef === value.primaryRepresentationId)?.id;
    value.representations = value.representations.map(({ _clientRef, ...rep }) => rep);
    if (value.payload?.items) value.payload.items = value.payload.items.map(item => ({ ...item, ...(item.sourceRefIds ? { sourceRefIds: item.sourceRefIds.map(resolveSource) } : {}) }));
    for (const rep of value.representations) if (rep.kind === "asset") { const asset = this.c.assets.assert(rep.assetId, actor); if (value.type === "image" && !asset.mediaType.startsWith("image/")) fail("ASSET_MEDIA_UNSUPPORTED", "Image block requires image assets."); }
    for (const source of value.sourceRefs) if (source.assetId) this.c.assets.assert(source.assetId, actor);
    return value;
  }
  persist(owner, object, blocks, actor) {
    const table = owner.kind === "group" ? "groups" : "nodes", old = this.store.get(table, object.id), now = new Date().toISOString();
    object.createdAt ??= now; object.createdBy ??= actorIdentity(actor); object.updatedAt = now; object.updatedBy = actorIdentity(actor);
    this.store.put(table, object.id, object);
    this.store.put("versions", objectKey(owner) + ":" + object.revision, { owner, object, blocks, previousRevision: old?.revision ?? null });
    for (const block of blocks) { this.store.put("blocks", block.id, block); this.store.put("versions", block.id + ":" + block.revision, block); }
  }
  relations(owner, scope = "direct", view = this.c.snapshot(null, { isAgent: false }, { includeBlocks: false })) {
    this.from(view, owner);
    if (scope === "direct") return view.topology.edges.filter(edge => sameObject(edge.from, owner) || sameObject(edge.to, owner));
    if (owner.kind !== "group" || scope !== "groupBoundary") fail("INPUT_INVALID", "groupBoundary requires a group.");
    const range = this.c.groups.range(owner.id, view), inside = new Set([...range.nodeIds.map(id => objectKey({ kind: "node", id })), ...range.groupIds.filter(id => id !== owner.id).map(id => objectKey({ kind: "group", id }))]);
    return view.topology.edges.filter(edge => !sameObject(edge.from, owner) && !sameObject(edge.to, owner) && inside.has(objectKey(edge.from)) !== inside.has(objectKey(edge.to)));
  }
  detail(owner) {
    const object = this.get(owner), graph = this.c.formalTopology();
    const allBlocks = this.blocks(owner, true), activeBlocks = allBlocks.filter(block => block.lifecycle !== "archived");
    const relations = this.relations(owner).map(edge => { const ref = sameObject(edge.from, owner) ? edge.to : edge.from; const other = this.get(ref); return { ...edge, other: { object: ref, label: other.core.nodeName, kind: ref.kind === "node" ? other.kind : "group", revision: other.revision } }; });
    const common = { schemaVersion: "research-object-detail.v1", owner, core: object.core, sourceRefs: object.sourceRefs, contentBlocks: activeBlocks.map(block => ({ ...block, excerpt: extractContentBlockText(block.type, block.payload).slice(0, 100) })), relations, nodeRevision: object.revision, revision: object.revision, coreRevision: object.coreRevision, blockCollectionRevision: object.blockCollectionRevision, relationRevision: object.relationRevision, stateVersion: graph.stateVersion };
    const bodyBlockId = activeBlocks.find(block => block.role === "body")?.id ?? (allBlocks.some(block => block.role === "body") ? null : activeBlocks.find(block => block.type === "richText")?.id ?? null);
    return owner.kind === "node" ? { ...common, node: this.c.nodes.project(object, graph), ...(object.kind === "note" ? { bodyBlockId } : {}), ...(object.kind === "experiment" ? { experiment: { revision: object.experimentRevision ?? 1, runs: object.runs ?? [], materialLinks: object.materialLinks ?? [] } } : {}) } : { ...common, group: object };
  }
}
