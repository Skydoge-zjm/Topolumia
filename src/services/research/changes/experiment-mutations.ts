import { fail } from "../../../domain/research/access.js";
import { sameObject } from "../../../domain/research/object-ref.js";

export function requireExperiment(object, owner) {
  if (owner.kind !== "node" || object.kind !== "experiment")
    fail("NODE_NOT_EXPERIMENT", "Run records belong to an experiment.", 422);

}

export function registerRecordRuns(c, node, owner, block, actor, allocate) {
  requireExperiment(node, owner);
  const object = block.recordCollection;
  c.records.validatePayload(block.payload, block.representations, actor);
  const provider = block.payload.provider;
  block.payload.runs = block.payload.runs.map((entry) => {
    if (entry.projectSource && entry.runId && entry.runId !== entry.projectSource.runId) fail("EXPERIMENT_RUN_CONFLICT", "项目来源需保留原始执行身份。", 422);
    const previous = object.runs.find((run) =>
      run.sources?.some(
        (source) =>
          source.provider === provider && source.sourceId === entry.sourceId,
      ),
    );
    let run = entry.runId
      ? object.runs.find((run) => run.id === entry.runId)
      : previous;
    if (entry.runId && !run)
      fail(
        "EXPERIMENT_RUN_NOT_FOUND",
        "Run does not belong to this experiment.",
        404,
      );
    if (previous && run && previous.id !== run.id)
      fail(
        "EXPERIMENT_RUN_CONFLICT",
        "This source is already associated with another run.",
        409,
      );
    if (!run) {
      run = {
        id: entry.projectSource?.runId ?? allocate("run", block.id + ":" + provider + ":" + entry.sourceId),
        label: entry.label,
        status: entry.status,
        sources: [],
        ...(entry.projectSource ? { metadataFields: [], projectSource: entry.projectSource } : {}),
      };
      object.runs.push(run);
    }
    if (
      !run.sources.some(
        (source) =>
          source.provider === provider && source.sourceId === entry.sourceId,
      )
    )
      run.sources.push({ provider, sourceId: entry.sourceId });
    return { ...entry, runId: run.id };
  });
  if (object.runs.length > 1000)
    fail("EXPERIMENT_LIMIT", "Experiment run limit exceeded.", 422);
}

export function applyExperimentPatch(
  c,
  object,
  owner,
  patch,
  blocks,
  allocate,
  operationIndex,
  actor,
  assetIds,
) {
  if (owner.kind !== "node") fail("NODE_NOT_EXPERIMENT", "Run records belong to an experiment.", 422);
  for (const [index, input] of (patch.addRuns ?? []).entries())
    object.runs.push({
      ...input,
      id: allocate("run", object.blockId + ":manual:" + operationIndex + ":" + index),
      sources: [],
    });
  const recordBlock = blocks.get(object.blockId);
  const liveRuns = [...c.ingestion.runs(object.blockId), ...(recordBlock ? c.projectRecords.runs(recordBlock) : [])];
  for (const change of patch.updateRuns ?? []) {
    if (!object.runs.some(run => run.id === change.id)) { const live = liveRuns.find(run => run.id === change.id); if (live) object.runs.push({ ...structuredClone(live), metadataFields: [] }); }
    const run = object.runs.find((run) => run.id === change.id);
    if (!run)
      fail(
        "EXPERIMENT_RUN_NOT_FOUND",
        "Run does not belong to this experiment.",
        404,
      );
    Object.assign(run, change);
    if (Array.isArray(run.metadataFields)) run.metadataFields = [...new Set([...run.metadataFields, ...Object.keys(change).filter(key => key !== "id")])];
  }
  for (const id of patch.removeLinkIds ?? []) {
    if (!object.materialLinks.some((link) => link.id === id))
      fail("EXPERIMENT_LINK_NOT_FOUND", "Material association not found.", 404);
    object.materialLinks = object.materialLinks.filter(
      (link) => link.id !== id,
    );
  }
  for (const [index, input] of (patch.addLinks ?? []).entries()) {
    if (![...object.runs, ...liveRuns].some((run) => run.id === input.runId))
      fail(
        "EXPERIMENT_RUN_NOT_FOUND",
        "Run does not belong to this experiment.",
        404,
      );
    const current = blocks.get(input.blockId);
    const version =
      current?.revision === input.blockRevision
        ? current
        : c.store.get("versions", input.blockId + ":" + input.blockRevision);
    if (!version || !sameObject(version.owner, owner))
      fail(
        "CONTENT_BLOCK_NOT_FOUND",
        "Material version does not belong to this experiment.",
        404,
      );
    if (
      ["asset", "assetRow"].includes(input.selection.kind) &&
      !version.representations?.some(
        (rep) =>
          rep.kind === "asset" && rep.assetId === input.selection.assetId,
      )
    )
      fail(
        "EXPERIMENT_MATERIAL_INVALID",
        "File does not belong to the selected block version.",
        422,
      );
    if (input.selection.kind === "assetRow") {
      const asset = c.assets.assert(input.selection.assetId, actor),
        fact =
          asset.tableSheetFacts?.[
            input.selection.sheet ?? asset.defaultSheet ?? ""
          ];
      if (
        !fact ||
        fact.checksum !== asset.checksum ||
        input.selection.rowIndex >= fact.rowCount
      )
        fail(
          "EXPERIMENT_MATERIAL_INVALID",
          "Read the selected worksheet and a valid row before associating it.",
          422,
        );
    }
    if (
      input.selection.kind === "row" &&
      (version.type !== "table" ||
        !version.payload?.rows?.[input.selection.rowIndex])
    )
      fail(
        "EXPERIMENT_MATERIAL_INVALID",
        "Table row does not exist in this block version.",
        422,
      );
    for (const representation of version.representations ?? [])
      if (representation.kind === "asset") {
        c.assets.assert(representation.assetId, actor);
        assetIds.add(representation.assetId);
      }
    const existing = object.materialLinks.find(
      (link) =>
        link.runId === input.runId &&
        link.blockId === input.blockId &&
        link.blockRevision === input.blockRevision &&
        JSON.stringify(link.selection) === JSON.stringify(input.selection),
    );
    if (!existing)
      object.materialLinks.push({
        ...input,
        id: allocate(
          "materialLink",
          owner.id + ":" + operationIndex + ":" + index,
        ),
      });
  }
  for (const id of patch.removeRunIds ?? []) {
    if (liveRuns.some(run => run.id === id)) fail("EXPERIMENT_RUN_IN_USE", "持续记录仍引用此运行；可归档记录块保留原始依据。", 409);
    if (!object.runs.some((run) => run.id === id))
      fail(
        "EXPERIMENT_RUN_NOT_FOUND",
        "Run does not belong to this experiment.",
        404,
      );
    if (
      object.materialLinks.some((link) => link.runId === id) ||
      [...blocks.values()].some(
        (block) =>
          block.id === object.blockId &&
          block.lifecycle !== "archived" &&
          block.type === "experimentRecord" &&
          block.payload.runs.some((run) => run.runId === id),
      )
    )
      fail(
        "EXPERIMENT_RUN_IN_USE",
        "Remove this run's material associations and record references before removing it.",
        409,
      );
    object.runs = object.runs.filter((run) => run.id !== id);
  }
  if (object.runs.length > 1000 || object.materialLinks.length > 4000)
    fail(
      "EXPERIMENT_LIMIT",
      "Experiment run or association limit exceeded.",
      422,
    );
}
