import { ExperimentRecordImporter } from "./record-importer.js";
import { fail } from "../../../domain/research/access.js";
import { nodeRef, sameObject } from "../../../domain/research/object-ref.js";
import { versionHash } from "../../../lib/hash.js";
import { recordNumber } from "../../../domain/research/record-ingestion.js";
import { experimentMetricId, type ExperimentMetricSelection } from "../../../domain/research/experiment-records.js";

export class ExperimentRecordService extends ExperimentRecordImporter {
  async prepareMaterialSelections(patch, actor) {
    for (const link of patch?.addLinks ?? [])
      if (link.selection.kind === "assetRow") {
        const table = await this.c.assets.values(
          link.selection.assetId,
          actor,
          {
            sheet: link.selection.sheet,
            rowOffset: link.selection.rowIndex,
            rowLimit: 1,
          },
        );
        if (link.selection.sheet === undefined && table.sheetName !== undefined)
          link.selection.sheet = table.sheetName;
      }
  }
  list(actor) {
    this.c.check(actor, "research.view");
    return {
      items: this.c.nodes
        .nodes()
        .filter((node) => node.kind === "experiment")
        .map((node) => ({
          id: node.id,
          name: node.core.nodeName,
          summary: node.core.summary ?? "",
          tags: node.core.tags ?? [],
          revision: node.revision,
          runs: this.overview(node.id, actor).runs.map(({ id, label, status, blockId }) => ({
            id,
            label,
            status, blockId,
          })),
        })),
    };
  }
  experiment(
    nodeId,
    actor,
    candidateId = undefined,
    candidateSnapshot = undefined,
  ) {
    this.c.check(actor, "research.view");
    const snapshot = candidateId
        ? (candidateSnapshot ?? this.c.snapshot(candidateId, actor))
        : null,
      node = snapshot
        ? snapshot.nodes.find((node) => node.id === nodeId)
        : this.c.nodes.node(nodeId);
    if (!node || node.deleted || node.kind !== "experiment")
      fail("NODE_NOT_EXPERIMENT", "实验节点不存在。", 404);
    return {
      node,
      blocks: (snapshot
        ? snapshot.blocks
        : this.c.store.blocksForOwner(nodeRef(nodeId))
      ).filter(
        (block) =>
          sameObject(block.owner, nodeRef(nodeId)) &&
          block.lifecycle !== "archived",
      ),
    };
  }
  validatePayload(payload, representations, actor) {
    const assets = new Set(
      representations
        .filter((rep) => rep.kind === "asset")
        .map((rep) => rep.assetId),
    );
    const seen = new Set();
    for (const run of payload.runs) {
      if (seen.has(run.sourceId))
        fail(
          "EXPERIMENT_RUN_DUPLICATE",
          "同一内容块中的来源 run 不能重复。",
          422,
        );
      seen.add(run.sourceId);
      if (run.projectSource) { this.c.projectRecords.validateEntry(run, payload.provider); continue; }
      if (!run.assetIds.length && !run.ref)
        fail(
          "EXPERIMENT_RECORD_SOURCE_REQUIRED",
          "实验记录需要原文件或已接入的运行来源。",
          422,
        );
      if (run.ref && !run.ref.startsWith(payload.provider + ":run:"))
        fail("EXPERIMENT_RECORD_INVALID", "运行来源与记录工具不一致。", 422);
      for (const id of run.assetIds) {
        if (!assets.has(id))
          fail(
            "EXPERIMENT_RECORD_INVALID",
            "记录文件必须保存在同一内容块的原始材料中。",
            422,
          );
        const asset = this.c.assets.assert(id, actor),
          manifest = asset.recordManifests?.[payload.provider];
        const sourceIds =
          manifest?.checksum === asset.checksum
            ? manifest.sourceIds
            : this.index(id, payload.provider, actor).runs.map(
                (item) => item.sourceId,
              );
        if (!sourceIds.includes(run.sourceId))
          fail("EXPERIMENT_RECORD_INVALID", "原文件中不存在所选 run。", 422);
      }
    }
    this.c.projectRecords.validateRules(payload.followSources, payload.provider);
  }
  material(node, link, blocks) {
    const current = blocks.find((block) => block.id === link.blockId);
    const block =
      current?.revision === link.blockRevision
        ? current
        : this.c.store.get("versions", link.blockId + ":" + link.blockRevision);
    if (!block || !sameObject(block.owner, nodeRef(node.id)))
      return { ...link, available: false };
    let item;
    if (["asset", "assetRow"].includes(link.selection.kind))
      item = block.representations.find(
        (rep) => rep.kind === "asset" && rep.assetId === link.selection.assetId,
      );
    if (link.selection.kind === "row")
      item = block.payload?.rows?.[link.selection.rowIndex];
    const readHint: any = {
      tool: "read_blocks",
      mode: "read",
      owner: nodeRef(node.id),
      blockId: block.id,
      revision: block.revision,
      expectedRevision: block.revision,
      view: link.selection.kind === "row" ? "values" : "manifest",
      ...(link.selection.kind === "row"
        ? {
            representationId: "inline",
            selection: { rowOffset: link.selection.rowIndex + 1, rowLimit: 1 },
          }
        : {}),
    };
    if (link.selection.kind === "assetRow") {
      const asset = this.c.store.get("assets", link.selection.assetId);
      Object.assign(readHint, {
        tool: "read_assets",
        assetId: link.selection.assetId,
        view: "values",
        expectedChecksum: asset?.checksum,
        selection: {
          sheet: link.selection.sheet,
          rowOffset: link.selection.rowIndex,
          rowLimit: 1,
        },
      });
      for (const key of [
        "mode",
        "owner",
        "blockId",
        "revision",
        "expectedRevision",
      ])
        delete readHint[key];
    }
    const preview =
      link.selection.kind === "row" && item
        ? Object.fromEntries(
            Object.entries(item)
              .slice(0, 12)
              .map(([key, value]) => [
                key,
                typeof value === "string" ? value.slice(0, 500) : value,
              ]),
          )
        : item;
    return {
      ...link,
      available: true,
      title: block.title,
      type: block.type,
      currentRevision: current?.revision ?? null,
      archived: !current,
      readHint,
      ...(preview !== undefined ? { item: preview } : {}),
    };
  }
  collectionRunCount(block) {
    return this.collectionRuns(block).length;
  }
  collectionRuns(block, liveRuns = this.c.ingestion.runs(block.id), includeProject = true) {
    if (includeProject) liveRuns = [...liveRuns, ...this.c.projectRecords.runs(block)];
    const runs = new Map<string, any>(liveRuns.map(run => [run.id, run]));
    for (const run of block.recordCollection?.runs ?? []) {
      const live = runs.get(run.id);
      if (run.projectSource && !live) continue;
      const overlay = live && Array.isArray(run.metadataFields) ? { id: run.id, sources: run.sources, ...Object.fromEntries(run.metadataFields.map(key => [key, run[key]])) } : run;
      runs.set(run.id, { ...live, ...overlay });
    }
    return [...runs.values()];
  }
  overview(nodeId, actor, candidateId = undefined, blockId = undefined) {
    const { node, blocks } = this.experiment(nodeId, actor, candidateId);
    const recordBlocks = blocks.filter(
      (block) => block.type === "experimentRecord" && (!blockId || block.id === blockId),
    );
    if (blockId && !recordBlocks.length) fail("CONTENT_BLOCK_NOT_FOUND", "实验记录块不存在。", 404);
    const collections = recordBlocks.map(block => ({ ...block.recordCollection, blockId: block.id, title: block.title }));
    const recordsByRun = new Map<string, any[]>();
    for (const block of recordBlocks)
      for (const entry of block.payload.runs ?? []) {
        const records = recordsByRun.get(JSON.stringify([block.id, entry.runId])) ?? [];
        records.push({
          blockId: block.id,
          blockRevision: block.revision,
          title: block.title,
          provider: block.payload.provider,
          ...entry,
        });
        recordsByRun.set(JSON.stringify([block.id, entry.runId]), records);
      }
    return {
      nodeId,
      blockId,
      revision: blockId ? collections[0].revision : node.revision,
      collections,
      runs: collections.flatMap(collection => this.collectionRuns(recordBlocks.find(block => block.id === collection.blockId)).map(run => ({ ...run, blockId: collection.blockId, collectionId: collection.id }))).map((run) => ({
        ...run,
        records: recordsByRun.get(JSON.stringify([run.blockId, run.id])) ?? [],
        readHint: {
          tool: "read_experiment",
          mode: "metrics",
          nodeId,
          blockId: run.blockId,
          runId: run.id,
        },
      })),
      materialLinks: collections.flatMap(collection => collection.materialLinks.map(link => ({ ...link, recordBlockId: collection.blockId, collectionId: collection.id }))).map((link) =>
        this.material(node, link, blocks),
      ),
    };
  }
  async runSeries(
    selection,
    actor,
    candidateId = undefined,
    blockId = undefined,
    blockRevision = undefined,
    allowPartial = false,
    scope: {
      views?: Map<string, any>;
      metricKeys?: string[];
      indices?: Map<string, Promise<any>>;
      entries?: Map<string, Map<string, { block: any; entry: any }[]>>;
      candidateSnapshot?: any;
    } = {},
  ) {
    blockId ??= selection.blockId;
    const pinned = selection.snapshotId ? this.c.ingestion.getSnapshot(selection.snapshotId, actor) : null;
    let selectedView = pinned ? { node: pinned.node, blocks: [pinned.block] } : scope.views?.get(selection.nodeId);
    if (!selectedView) {
      selectedView = this.experiment(
        selection.nodeId,
        actor,
        candidateId,
        scope.candidateSnapshot,
      );
      scope.views?.set(selection.nodeId, selectedView);
    }
    const view = selectedView,
      node = view.node;
    let blocks = view.blocks;
    if (blockId && blockRevision !== undefined) {
      const current = blocks.find((block) => block.id === blockId);
      blocks = [
        current?.revision === blockRevision
          ? current
          : this.c.objects.blockVersion(
              nodeRef(node.id),
              blockId,
              blockRevision,
            ),
      ];
    }
    if (pinned && (pinned.nodeId !== node.id || selection.blockId && pinned.blockId !== selection.blockId || blockId && pinned.blockId !== blockId)) fail("INGESTION_SCOPE_MISMATCH", "快照不属于所选记录。", 403);
    if (pinned) blocks = [pinned.block];
    const matches = blocks.filter(block => block.type === "experimentRecord" && (!blockId || block.id === blockId) && (!selection.blockId || block.id === selection.blockId)).flatMap(block => this.collectionRuns(block, pinned ? pinned.runs : this.c.ingestion.runs(block.id), !pinned).filter(run => run.id === selection.runId).map(run => ({ ...run, blockId: block.id })));
    if (matches.length > 1) fail("EXPERIMENT_RUN_AMBIGUOUS", "请选择记录块。", 422);
    const run = matches[0];
    if (!run) fail("EXPERIMENT_RUN_NOT_FOUND", "执行记录不属于所选实验。", 404);
    const lines = new Map(),
      sources = new Set(),
      warnings: any[] = [];
    const unavailable = (error, source) => {
      if (!allowPartial || error.status === 403) throw error;
      warnings.push({
        nodeId: node.id,
        runId: run.id,
        ...source,
        code: error.code ?? "EXPERIMENT_SOURCE_UNAVAILABLE",
        message: String(error.message ?? "实验记录不可用。").slice(0, 500),
      });
    };
    const append = (line, source) => {
      if (scope.metricKeys?.length && !scope.metricKeys.includes(line.key))
        return;
      const key = JSON.stringify([line.key, line.xKey ?? "step"]),
        item = lines.get(key) ?? {
          key: line.key,
          xKey: line.xKey ?? "step",
          unit: line.unit,
          pointCount: 0,
          segments: [],
          sources: [],
        };
      item.pointCount += line.pointCount ?? line.points?.length ?? 0;
      item.segments.push(
        source.assetId
          ? {
              assetId: source.assetId,
              provider: source.provider,
              sourceId: source.sourceId,
            }
          : { points: line.points },
      );
      item.sources.push(source);
      lines.set(key, item);
    };
    const entryKey =
      node.id +
      "|" +
      blocks
        .filter(
          (block) =>
            block.type === "experimentRecord" &&
            (!blockId || block.id === blockId),
        )
        .map((block) => block.id + ":" + block.revision)
        .join("|");
    let entriesByRun = scope.entries?.get(entryKey);
    if (!entriesByRun) {
      entriesByRun = new Map();
      for (const block of blocks)
        if (
          block.type === "experimentRecord" &&
          (!blockId || block.id === blockId)
        )
          for (const entry of block.payload.runs ?? []) {
            const entries = entriesByRun.get(entry.runId) ?? [];
            entries.push({ block, entry });
            entriesByRun.set(entry.runId, entries);
          }
      scope.entries?.set(entryKey, entriesByRun);
    }
    for (const { block, entry } of entriesByRun.get(run.id) ?? []) {
      for (const assetId of entry.assetIds) {
        try {
          const identity = JSON.stringify([
            block.payload.provider,
            assetId,
            entry.sourceId,
          ]);
          if (sources.has(identity)) continue;
          sources.add(identity);
          const indexKey = JSON.stringify([assetId, block.payload.provider]);
          let loading = scope.indices?.get(indexKey);
          if (!loading) {
            loading = this.indexed(assetId, block.payload.provider, actor);
            scope.indices?.set(indexKey, loading);
          }
          const index = await loading,
            sourceRun = index.runs.find(
              (item) => item.sourceId === entry.sourceId,
            );
          if (!sourceRun)
            fail("EXPERIMENT_RECORD_CHANGED", "原始记录与内容块不一致。", 409);
          for (const diagnostic of sourceRun.nativeSemantics?.warnings?.slice(0, 5) ?? []) warnings.push({ nodeId: node.id, runId: run.id, blockId: block.id, code: "EXPERIMENT_DEPENDENCY_MISSING", message: "缺少伴随文件：" + (diagnostic.missingDependencies ?? []).slice(0, 2).join(", ").slice(0, 300) });
          for (const line of sourceRun.series)
            append(line, {
              blockId: block.id,
              blockRevision: block.revision,
              assetId,
              contentVersion: index.contentVersion,
              provider: block.payload.provider,
              sourceId: entry.sourceId,
            });
        } catch (error) {
          unavailable(error, { assetId });
        }
      }
      if (entry.ref && !entry.assetIds.length && !sources.has(entry.ref)) {
        try {
          this.c.check(actor, "experiment.view");
          if (!this.options.gateway)
            fail("EXPERIMENT_SOURCE_UNAVAILABLE", "实验记录来源未接入。", 422);
          sources.add(entry.ref);
          const result = await this.options.gateway.series(entry.ref, {
            maxPoints: 2000,
          });
          for (const line of result.series ?? [])
            append(line, {
              blockId: block.id,
              blockRevision: block.revision,
              ref: entry.ref,
              provider: block.payload.provider,
              observedAt: result.observedAt,
              sampledAtSource: true,
            });
        } catch (error) {
          unavailable(error, { ref: entry.ref });
        }
      }
    }
    for (const line of this.c.ingestion.metrics(run.blockId, run.id, pinned?.watermark)) {
      if (scope.metricKeys?.length && !scope.metricKeys.includes(line.key)) continue;
      lines.set(JSON.stringify([line.key, line.xKey]), line);
    }
    const selectedBlock = blocks.find(block => block.id === run.blockId);
    for (const binding of this.c.projectRecords.bindings(selectedBlock, pinned).filter(binding => binding.runId === run.id)) {
      for (const line of this.c.ingestion.metrics(binding.sourceId, binding.runId, binding.watermark)) {
        if (scope.metricKeys?.length && !scope.metricKeys.includes(line.key)) continue;
        line.sources = line.sources.map(source => ({ ...source, sourceId: binding.sourceId, blockId: run.blockId }));
        lines.set(JSON.stringify([line.key, line.xKey]), line);
      }
    }
    return {
      nodeId: node.id,
      nodeName: node.core.nodeName,
      blockId: run.blockId,
      runId: run.id,
      runLabel: run.label,
      status: run.status,
      sources: run.sources,
      warnings,
      series: [...lines.values()],
    };
  }
  async staticBlockEvents(block, actor, { runId, kind }: { runId?: string; kind?: string } = {}) {
    const result = [];
    let order = 0;
    for (const entry of block.payload?.runs ?? []) {
      if (runId && entry.runId !== runId) continue;
      for (const assetId of entry.assetIds ?? []) {
        const runs = await this.staticEvents(assetId, block.payload.provider, actor);
        const source = runs.find((run) => run.sourceId === entry.sourceId);
        for (const [eventIndex, sourceEvent] of (source?.events ?? []).entries()) {
          const event = {
            ...sourceEvent,
            sourceRunId: sourceEvent.sourceRunId ?? entry.sourceId,
            ...(sourceEvent.seq === undefined ? { seq: eventIndex } : {}),
          };
          if (kind && event.kind !== kind) continue;
          result.push({
            order: order++,
            runId: entry.runId,
            event,
            eventAssetId: assetId,
            eventSourceId: entry.sourceId,
            eventIndex,
          });
        }
      }
    }
    return result;
  }
  async events(input, actor) {
    this.c.check(actor, "research.view");
    const snapshot = input.snapshotId ? this.c.ingestion.getSnapshot(input.snapshotId, actor) : null,
      blockView = snapshot ? { blocks: [snapshot.block] } : this.experiment(input.nodeId, actor, input.candidateId),
      block = blockView.blocks.find((item) => item.id === input.blockId && item.type === "experimentRecord" && item.lifecycle !== "archived");
    if (!block) fail("CONTENT_BLOCK_NOT_FOUND", "实验记录块不存在。", 404);
    const staticItems = await this.staticBlockEvents(block, actor, { runId: input.runId, kind: input.eventKind });
    const after = input.after ?? 0, limit = Math.min(100, input.limit ?? 20), live = this.c.ingestion.events(input.blockId, actor, { after: Math.max(0, after - staticItems.length), limit, snapshotId: input.snapshotId, runId: input.runId, kind: input.eventKind }), items = [];
    if (after < staticItems.length) items.push(...staticItems.slice(after, after + limit));
    if (items.length < limit) items.push(...live.items.slice(0, limit - items.length));
    const normalized = items.map(item => ({
      watermark: item.eventAssetId ? item.order + 1 : staticItems.length + item.watermark,
      runId: item.runId,
      event: item.event,
      totalChars: item.totalChars ?? JSON.stringify(item.event).length,
      ...(item.eventAssetId ? { eventAssetId: item.eventAssetId, eventSourceId: item.eventSourceId, eventIndex: item.eventIndex } : {}),
      readHint: item.eventAssetId ? { tool: "read_experiment", mode: "events", nodeId: input.nodeId, blockId: input.blockId, eventWatermark: item.order + 1, eventAssetId: item.eventAssetId, eventSourceId: item.eventSourceId, eventIndex: item.eventIndex, ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}) } : item.readHint,
      attachments: (item.event?.data?.attachments ?? []).map(attachment => ({ ...attachment, downloadHint: { tool: "transfer_asset", direction: "download", variant: "original", target: { kind: "recordAttachment", blockId: input.blockId, sha256: attachment.sha256, ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}) } } })),
    }));
    const watermark = staticItems.length + live.watermark, last = normalized.at(-1)?.watermark;
    return { items: normalized, watermark, nextAfter: last !== undefined && last < watermark ? last : null, snapshotId: input.snapshotId };
  }
  async staticEventText(input, actor) {
    const block = this.c.objects.block({ kind: "node", id: input.nodeId }, input.blockId),
      runs = await this.staticEvents(input.eventAssetId, block.payload.provider, actor),
      source = runs.find((run) => run.sourceId === input.eventSourceId),
      event = source?.events?.[input.eventIndex];
    if (!event) fail("RECORD_EVENT_NOT_FOUND", "静态导入事件不存在。", 404);
    const text = JSON.stringify(event), offset = input.textOffset ?? 0, length = input.textLength ?? 4000;
    return { blockId: input.blockId, eventWatermark: input.eventWatermark, text: text.slice(offset, offset + length), totalChars: text.length, offset, nextOffset: offset + length < text.length ? offset + length : null, snapshotId: input.snapshotId };
  }
  async selectPoints(lines, selection, actor) {
    const staticLines = lines.filter(line => !line.segments[0]?.live);
    const staticValues = staticLines.length ? await super.selectPoints(staticLines, selection, actor) : [];
    for (const value of staticValues) value.points = value.points.map(point => ({ x: point.originalX ?? point.x, y: point.originalY ?? point.y, ...(point.timestamp !== undefined ? { timestamp: point.timestamp } : {}) }));
    let index = 0;
    return lines.map(line => { const live = line.segments[0]; return live?.live ? this.c.ingestion.points(live.blockId, live.runId, line.key, line.xKey, selection, live.watermark) : staticValues[index++]; });
  }
  async plot(input, actor) {
    this.c.check(actor, "research.view");
    const wholeExperiments = input.nodeIds !== undefined;
    const scope = {
      views: new Map<string, any>(),
      indices: new Map<string, Promise<any>>(),
      entries: new Map<string, Map<string, { block: any; entry: any }[]>>(),
      candidateSnapshot: input.candidateId
        ? this.c.snapshot(input.candidateId, actor)
        : undefined,
    };
    let selections = input.selections;
    const wholeBlock = input.blockId !== undefined && input.nodeId !== undefined && input.selections === undefined;
    if (wholeBlock) selections = this.overview(input.nodeId, actor, input.candidateId, input.blockId).runs.map(run => ({ nodeId: input.nodeId, blockId: input.blockId, runId: run.id }));
    if (wholeExperiments) {
      if (
        input.selections !== undefined ||
        input.blockId !== undefined ||
        !Array.isArray(input.nodeIds) ||
        input.nodeIds.length < 2 ||
        input.nodeIds.length > 100 ||
        input.nodeIds.some(
          (id) => typeof id !== "string" || !id || id.length > 500,
        ) ||
        new Set(input.nodeIds).size !== input.nodeIds.length
      )
        fail("INPUT_INVALID", "请选择 2–100 个不同的实验。", 422);
      selections = input.nodeIds.flatMap((nodeId) => {
        const view = this.experiment(
          nodeId,
          actor,
          input.candidateId,
          scope.candidateSnapshot,
        );
        scope.views.set(nodeId, view);
        return this.overview(nodeId, actor, input.candidateId).runs.map((run) => ({ nodeId, blockId: run.blockId, runId: run.id }));
      });
    }
    const selectionLimit = input.blockId ? 200 : 24;
    if (
      !Array.isArray(selections) ||
      (!wholeExperiments && !wholeBlock &&
        (!selections.length || selections.length > selectionLimit)) ||
      selections.some(
        (item) =>
          !item ||
          typeof item.nodeId !== "string" ||
          !item.nodeId ||
          typeof item.runId !== "string" ||
          !item.runId,
      )
    )
      fail("INPUT_INVALID", `请选择 1–${selectionLimit} 条执行记录。`, 422);
    if (
      input.blockId &&
      new Set(selections.map((item) => item.nodeId)).size !== 1
    )
      fail("INPUT_INVALID", "记录内容块的运行必须属于同一实验。", 422);
    if (
      new Set(
        selections.map((item) => JSON.stringify([item.nodeId, item.blockId ?? input.blockId, item.runId])),
      ).size !== selections.length
    )
      fail("INPUT_INVALID", "执行记录不能重复。", 422);
    const maxPoints = input.maxPoints ?? 800;
    if (!Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > 2000)
      fail("INPUT_INVALID", "maxPoints 必须为 2–2000。", 422);
    const runs: any[] = [];
    // Reading a set of experiments must retain every run, including failures.
    // Bound source reads instead of silently truncating the run directory.
    for (let offset = 0; offset < selections.length; offset += 8) {
      runs.push(
        ...(await Promise.all(
          selections
            .slice(offset, offset + 8)
            .map((selection) =>
              this.runSeries(
                selection,
                actor,
                input.candidateId,
                input.blockId,
                input.blockRevision,
                true,
                scope,
              ),
            ),
        )),
      );
    }
    const allKeys = [
      ...new Set<string>(
        runs.flatMap((run) => run.series.map((line) => line.key)),
      ),
    ];
    const requested =
      Array.isArray(input.metricKeys) && input.metricKeys.length
        ? input.metricKeys
        : allKeys.slice(0, 32);
    if (
      requested.length > 32 ||
      requested.some((key) => typeof key !== "string")
    )
      fail("INPUT_INVALID", "一次最多读取 32 项指标。", 422);
    const selectedLineCount = runs.reduce(
      (count, run) =>
        count +
        run.series.filter((line) => requested.includes(line.key)).length,
      0,
    );
    const displayPointLimit = Math.min(
      maxPoints,
      Math.max(2, Math.floor(40_000 / Math.max(1, selectedLineCount))),
    );
    const selectedLines = runs.flatMap((run) =>
      run.series.filter((line) => requested.includes(line.key)),
    );
    const values = selectedLines.length
      ? await this.selectPoints(
          selectedLines,
          { maxPoints: displayPointLimit },
          actor,
        )
      : [];
    let lineIndex = 0;
    return {
      temporary: true,
      metricKeys: allKeys,
      omittedMetricCount: Math.max(0, allKeys.length - requested.length),
      warnings: runs.flatMap((run) => run.warnings),
      runs: runs.map(({ series: _series, warnings: _warnings, ...run }) => run),
      series: runs.flatMap((run) =>
        run.series
          .filter((line) => requested.includes(line.key))
          .map(({ segments: _segments, ...line }) => ({
            nodeId: run.nodeId,
            blockId: run.blockId,
            nodeName: run.nodeName,
            runId: run.runId,
            runLabel: run.runLabel,
            ...line,
            contentVersion: versionHash(line.sources),
            points: values[lineIndex++].points.map(point => ({ ...point, x: recordNumber(point.x), y: recordNumber(point.y) })).filter(point => point.x !== null && point.y !== null),
            pointCount: line.pointCount,
            sampled:
              line.pointCount > displayPointLimit ||
              line.sources.some((source) => source.sampledAtSource),
            sampling:
              line.pointCount > displayPointLimit
                ? "extrema-bucket"
                : line.sources.some((source) => source.sampledAtSource)
                  ? "source"
                  : "none",
          })),
      ),
    };
  }
  async table(input, actor) {
    this.c.check(actor, "research.view");
    const metrics: ExperimentMetricSelection[] = input.metrics,
      offset = input.pointOffset ?? 0,
      limit = input.pointLimit ?? 100;
    if (
      !Array.isArray(metrics) ||
      !metrics.length ||
      metrics.length > 24 ||
      metrics.some((metric) => !metric || typeof metric.key !== "string" || !metric.key || metric.key.length > 500 || typeof metric.xKey !== "string" || !metric.xKey || metric.xKey.length > 500 || (metric.expectedContentVersion !== undefined && typeof metric.expectedContentVersion !== "string")) ||
      new Set(metrics.map(experimentMetricId)).size !== metrics.length ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      fail("INPUT_INVALID", "请选择 1–24 个指标及合法的数据点范围。", 422);
    const run = await this.runSeries(
      { nodeId: input.nodeId, blockId: input.blockId, runId: input.runId, snapshotId: input.snapshotId },
      actor,
      input.candidateId,
      undefined,
      undefined,
      false,
      { metricKeys: metrics.map(metric => metric.key) },
    );
    const lines = metrics.map(
      (metric) =>
        run.series.find((line) => line.key === metric.key && line.xKey === metric.xKey) ??
        fail(
          "EXPERIMENT_METRIC_NOT_FOUND",
          "该次执行没有完全同名的指标。",
          404,
        ),
    );
    for (const [index, line] of lines.entries())
      if (
        metrics[index].expectedContentVersion &&
        metrics[index].expectedContentVersion !== versionHash(line.sources)
      )
        fail("OBJECT_VERSION_CONFLICT", "曲线来源已更新，请重新读取。", 409);
    const values = await this.selectPoints(lines, { offset, limit }, actor);
    return {
      columns: lines.map((line, index) => ({
        metric: line.key,
        xKey: line.xKey,
        contentVersion: versionHash(line.sources),
        pointCount: line.pointCount,
        offset,
        nextOffset:
          offset + values[index].points.length < line.pointCount
            ? offset + values[index].points.length
            : null,
        sampled: line.sources.some((source) => source.sampledAtSource),
        points: values[index].points,
      })),
    };
  }
  async read(input, actor) {
    if (input.snapshotId) {
      const pinned = this.c.ingestion.getSnapshot(input.snapshotId, actor);
      if (input.nodeId && input.nodeId !== pinned.nodeId || input.blockId && input.blockId !== pinned.blockId) fail("INGESTION_SCOPE_MISMATCH", "快照不属于所选实验。", 403);
      input = { ...input, nodeId: input.nodeId ?? pinned.nodeId, blockId: input.blockId ?? pinned.blockId };
    }
    const q = this.c.queries,
      params = { ...input, actor };
    this.c.check(actor, "research.view");
    if (input.mode === "available") {
      const data = this.c.projectRecords.directory(actor, { offset: input.recordOffset ?? 0, limit: input.limit ?? 10, q: input.query ?? "", hostId: input.hostId ?? "", provider: input.provider ?? "", unassigned: input.unassigned ?? false });
      return q.page("experiment", data.items, params, { mode: "available", offset: input.recordOffset ?? 0, records: data.items.map(item => item.projectSource) }, null, { total: data.total, nextOffset: data.nextOffset });
    }
    if (input.mode === "snapshot") {
      const snapshot = input.snapshotId ? this.c.ingestion.getSnapshot(input.snapshotId, actor) : this.c.ingestion.snapshot(input.blockId, actor);
      return q.finish(q.envelope("experiment", { snapshot: { id: snapshot.id, blockId: snapshot.blockId, nodeId: snapshot.nodeId, watermark: snapshot.watermark, blockRevision: snapshot.blockRevision, createdAt: snapshot.createdAt }, readHint: { tool: "read_experiment", mode: "runs", nodeId: snapshot.nodeId, blockId: snapshot.blockId, snapshotId: snapshot.id } }, params));
    }
    if (input.mode === "events") {
      if (input.eventWatermark !== undefined) {
        const data = input.eventAssetId ? await this.staticEventText(input, actor) : this.c.ingestion.eventText(input.blockId, input.eventWatermark, actor, input.textOffset, input.textLength, input.snapshotId);
        return q.finish(q.envelope("experiment", data, params, { coverage: { complete: data.offset === 0 && data.nextOffset === null, omissions: data.offset > 0 || data.nextOffset !== null ? ["partialEventText"] : [] } }));
      }
      const result = await this.events(input, actor);
      const items = result.items.map(item => JSON.stringify(item.event).length > 1500 ? { ...item, event: { kind: item.event.kind, key: item.event.key, sourceRunId: item.event.sourceRunId, data: { preview: JSON.stringify(item.event.data).slice(0, 1000), truncated: true } } } : item);
      const page = q.page("experiment", items, params, { blockId: input.blockId, after: input.after, watermark: result.watermark, snapshotId: input.snapshotId, kind: input.eventKind, runId: input.runId }, null, { watermark: result.watermark, nextAfter: result.nextAfter, snapshotId: input.snapshotId });
      if (page.data.items.some(item => item.event.data?.truncated)) { page.coverage.complete = false; page.coverage.omissions.push("recordPreview"); }
      return q.finish(page);
    }
    if (input.mode === "inspect") {
      const index = await this.inspect(input.provider, input.assetIds, actor);
      return q.page(
        "experiment",
        index.runs,
        params,
        { provider: index.provider, assets: input.assetIds },
        null,
        { provider: index.provider, diagnostics: index.diagnostics, omittedDiagnosticCount: index.omittedDiagnosticCount },
      );
    }
    if (input.mode === "compare") {
      const plot = await this.plot(
        { ...input, maxPoints: Math.min(100, input.pointLimit ?? 40) },
        actor,
      );
      const result = q.page(
        "experiment",
        plot.series,
        params,
        {
          selections: input.selections,
          nodeIds: input.nodeIds,
          metrics: input.metricKeys,
          versions: plot.series.map((line) => line.sources),
        },
        null,
        {
          temporary: true,
          runs: plot.runs,
          metricKeys: plot.metricKeys,
          warnings: plot.warnings,
        },
      );
      if (plot.warnings.length) {
        result.coverage.complete = false;
        result.coverage.omissions.push("unavailableSources");
      }
      return q.finish(result);
    }
    const pinnedDirectory = input.snapshotId ? this.c.ingestion.getSnapshot(input.snapshotId, actor) : null;
    const experimentView = pinnedDirectory ? { node: pinnedDirectory.node, blocks: [pinnedDirectory.block] } : this.experiment(input.nodeId, actor, input.candidateId);
    if (pinnedDirectory && (pinnedDirectory.nodeId !== input.nodeId || input.blockId && pinnedDirectory.blockId !== input.blockId)) fail("INGESTION_SCOPE_MISMATCH", "快照不属于所选实验。", 403);
    const view = pinnedDirectory && ["runs", "materials"].includes(input.mode) ? { revision: pinnedDirectory.recordCollection.revision, runs: this.collectionRuns({ id: pinnedDirectory.blockId, recordCollection: pinnedDirectory.recordCollection }, pinnedDirectory.runs, false).map(run => ({ ...run, readHint: { tool: "read_experiment", mode: "metrics", nodeId: input.nodeId, blockId: pinnedDirectory.blockId, snapshotId: pinnedDirectory.id, runId: run.id } })), materialLinks: pinnedDirectory.recordCollection.materialLinks.map(link => this.material({ id: input.nodeId }, link, experimentView.blocks)) } : ["runs", "materials"].includes(input.mode)
      ? this.overview(input.nodeId, actor, input.candidateId, input.blockId)
      : {
          revision: input.blockId ? experimentView.blocks.find(block => block.id === input.blockId)?.recordCollection?.revision : experimentView.node.revision,
          runs: [],
          materialLinks: [],
        };
    const receipts = (items = []) => [
      ...(input.blockId ? [q.receipt(actor, "block", input.blockId, experimentView.blocks.find(block => block.id === input.blockId)?.revision, "directory", { section: input.mode }, input, { owner: nodeRef(input.nodeId) })] : []),
      q.receipt(
        actor,
        "experiment",
        input.blockId ?? input.nodeId,
        view.revision,
        "directory",
        {
          section: input.mode,
          ...(input.mode === "runs"
            ? { runIds: items.map((item) => item.id) }
            : input.mode === "materials"
              ? { linkIds: items.map((item) => item.id) }
              : {}),
        },
        input,
        { owner: nodeRef(input.nodeId) },
      ),
    ];
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== view.revision
    )
      fail("OBJECT_VERSION_CONFLICT", "实验执行记录已更新，请重新读取。", 409);
    if (input.mode === "runs")
      return q.page(
        "experiment",
        view.runs,
        params,
        { nodeId: input.nodeId, blockId: input.blockId, snapshotId: input.snapshotId, revision: view.revision, watermark: pinnedDirectory?.watermark ?? (input.blockId ? this.c.ingestion.version(input.blockId, actor).durableWatermark : undefined) },
        receipts,
        { nodeId: input.nodeId, blockId: input.blockId, snapshotId: input.snapshotId, revision: view.revision, watermark: pinnedDirectory?.watermark ?? (input.blockId ? this.c.ingestion.version(input.blockId, actor).durableWatermark : undefined) },
      );
    if (input.mode === "materials")
      return q.page(
        "experiment",
        view.materialLinks.filter(
          (link) => !input.runId || link.runId === input.runId,
        ),
        params,
        { nodeId: input.nodeId, runId: input.runId, revision: view.revision },
        receipts,
        { nodeId: input.nodeId, blockId: input.blockId, snapshotId: input.snapshotId, revision: view.revision, watermark: pinnedDirectory?.watermark ?? (input.blockId ? this.c.ingestion.version(input.blockId, actor).durableWatermark : undefined) },
      );
    const run = await this.runSeries(
      { nodeId: input.nodeId, blockId: input.blockId, runId: input.runId, snapshotId: input.snapshotId },
      actor,
      input.candidateId,
      input.blockId,
      input.blockRevision,
      false,
      {
        views: new Map([[input.nodeId, experimentView]]),
        ...(input.mode === "series" ? { metricKeys: [input.metric] } : {}),
      },
    );
    if (input.mode === "metrics")
      return q.page(
        "experiment",
        run.series.map((line) => ({
          key: line.key,
          xKey: line.xKey,
          pointCount: line.pointCount,
          sampled: line.sources.some((source) => source.sampledAtSource),
          readHint: {
            ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
            tool: "read_experiment",
            mode: "series",
            nodeId: input.nodeId,
            blockId: run.blockId,
            runId: input.runId,
            metric: line.key,
            xKey: line.xKey,
            ...(input.blockId
              ? { blockId: input.blockId, blockRevision: input.blockRevision }
              : {}),
            ...(input.candidateId ? { candidateId: input.candidateId } : {}),
            expectedContentVersion: versionHash(line.sources),
          },
        })),
        params,
        {
          nodeId: input.nodeId,
          runId: input.runId,
          versions: run.series.map((line) => line.sources),
        },
        receipts,
        { nodeId: input.nodeId, blockId: input.blockId, runId: input.runId, snapshotId: input.snapshotId },
      );
    const matches = run.series.filter((line) => line.key === input.metric && (input.xKey === undefined || line.xKey === input.xKey));
    if (matches.length > 1)
      fail("EXPERIMENT_METRIC_AMBIGUOUS", "该指标包含多种横轴，请按目录中的 xKey 选择。", 422, { metric: input.metric, xKeys: matches.map(line => line.xKey) });
    const line = matches[0];
    if (!line)
      fail("EXPERIMENT_METRIC_NOT_FOUND", "该次执行没有完全同名的指标。", 404);
    const contentVersion = versionHash(line.sources);
    if (
      input.expectedContentVersion &&
      input.expectedContentVersion !== contentVersion
    )
      fail("OBJECT_VERSION_CONFLICT", "曲线来源已更新，请重新读取。", 409);
    const offset = input.pointOffset ?? 0,
      limit = input.pointLimit ?? 40;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      fail("INPUT_INVALID", "请指定合法的数据点范围。", 422);
    const [{ points }] = await this.selectPoints(
      [line],
      { offset, limit },
      actor,
    );
    const sampled = line.sources.some((source) => source.sampledAtSource);
    return q.finish(
      q.envelope(
        "experiment",
        {
          nodeId: input.nodeId,
          runId: input.runId,
          metric: line.key,
          xKey: line.xKey,
          contentVersion,
          sources: line.sources,
          points,
          pointCount: line.pointCount,
          offset,
          nextOffset:
            offset + points.length < line.pointCount
              ? offset + points.length
              : null,
          sampled,
        },
        params,
        {
          coverage: {
            complete:
              !sampled && offset === 0 && points.length === line.pointCount,
            omissions: [
              ...(points.length === line.pointCount ? [] : ["morePoints"]),
              ...(sampled ? ["sourceSampled"] : []),
            ],
          },
        },
      ),
      receipts(),
    );
  }
}
