import { ExperimentRecordImporter } from "./record-importer.js";
import { fail } from "../../../domain/research/access.js";
import { nodeRef, sameObject } from "../../../domain/research/object-ref.js";
import { downsamplePoints } from "../../../domain/experiments/experiment-domain.js";
import { versionHash } from "../../../lib/hash.js";

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
          revision: node.experimentRevision ?? 1,
          runs: (node.runs ?? []).map(({ id, label, status }) => ({
            id,
            label,
            status,
          })),
        })),
    };
  }
  experiment(nodeId, actor, candidateId = undefined) {
    this.c.check(actor, "research.view");
    const snapshot = this.c.snapshot(candidateId, actor),
      node = snapshot.nodes.find((node) => node.id === nodeId);
    if (!node || node.kind !== "experiment")
      fail("NODE_NOT_EXPERIMENT", "实验节点不存在。", 404);
    return {
      node,
      blocks: snapshot.blocks.filter(
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
  overview(nodeId, actor, candidateId = undefined) {
    const { node, blocks } = this.experiment(nodeId, actor, candidateId);
    const recordBlocks = blocks.filter(
      (block) => block.type === "experimentRecord",
    );
    return {
      nodeId,
      revision: node.experimentRevision ?? 1,
      runs: (node.runs ?? []).map((run) => ({
        ...run,
        records: recordBlocks.flatMap((block) =>
          block.payload.runs
            .filter((entry) => entry.runId === run.id)
            .map((entry) => ({
              blockId: block.id,
              blockRevision: block.revision,
              title: block.title,
              provider: block.payload.provider,
              ...entry,
            })),
        ),
        readHint: {
          tool: "read_experiment",
          mode: "metrics",
          nodeId,
          runId: run.id,
        },
      })),
      materialLinks: (node.materialLinks ?? []).map((link) =>
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
  ) {
    const view = this.experiment(selection.nodeId, actor, candidateId),
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
    const run = (node.runs ?? []).find((run) => run.id === selection.runId);
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
      const key = JSON.stringify([line.key, line.xKey ?? "step"]),
        item = lines.get(key) ?? {
          key: line.key,
          xKey: line.xKey ?? "step",
          unit: line.unit,
          points: [],
          sources: [],
        };
      item.points.push(...line.points);
      item.sources.push(source);
      lines.set(key, item);
    };
    for (const block of blocks.filter(
      (block) =>
        block.type === "experimentRecord" && (!blockId || block.id === blockId),
    )) {
      for (const entry of block.payload.runs.filter(
        (entry) => entry.runId === run.id,
      )) {
        for (const assetId of entry.assetIds) {
          try {
            const identity = JSON.stringify([
              block.payload.provider,
              assetId,
              entry.sourceId,
            ]);
            if (sources.has(identity)) continue;
            sources.add(identity);
            const index = await this.indexed(
                assetId,
                block.payload.provider,
                actor,
              ),
              sourceRun = index.runs.find(
                (item) => item.sourceId === entry.sourceId,
              );
            if (!sourceRun)
              fail(
                "EXPERIMENT_RECORD_CHANGED",
                "原始记录与内容块不一致。",
                409,
              );
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
              fail(
                "EXPERIMENT_SOURCE_UNAVAILABLE",
                "实验记录来源未接入。",
                422,
              );
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
    }
    return {
      nodeId: node.id,
      nodeName: node.core.nodeName,
      runId: run.id,
      runLabel: run.label,
      status: run.status,
      warnings,
      series: [...lines.values()],
    };
  }
  async plot(input, actor) {
    this.c.check(actor, "research.view");
    const selections = input.selections;
    const selectionLimit = input.blockId ? 200 : 24;
    if (
      !Array.isArray(selections) ||
      !selections.length ||
      selections.length > selectionLimit ||
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
        selections.map((item) => JSON.stringify([item.nodeId, item.runId])),
      ).size !== selections.length
    )
      fail("INPUT_INVALID", "执行记录不能重复。", 422);
    const maxPoints = input.maxPoints ?? 800;
    if (!Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > 2000)
      fail("INPUT_INVALID", "maxPoints 必须为 2–2000。", 422);
    const runs = await Promise.all(
      selections.map((selection) =>
        this.runSeries(
          selection,
          actor,
          input.candidateId,
          input.blockId,
          input.blockRevision,
          true,
        ),
      ),
    );
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
    return {
      temporary: true,
      metricKeys: allKeys,
      omittedMetricCount: Math.max(0, allKeys.length - requested.length),
      warnings: runs.flatMap((run) => run.warnings),
      runs: runs.map(({ series: _series, warnings: _warnings, ...run }) => run),
      series: runs.flatMap((run) =>
        run.series
          .filter((line) => requested.includes(line.key))
          .map((line) => ({
            nodeId: run.nodeId,
            nodeName: run.nodeName,
            runId: run.runId,
            runLabel: run.runLabel,
            ...line,
            contentVersion: versionHash(line.sources),
            points: downsamplePoints(line.points, displayPointLimit),
            pointCount: line.points.length,
            sampled:
              line.points.length > displayPointLimit ||
              line.sources.some((source) => source.sampledAtSource),
            sampling:
              line.points.length > displayPointLimit
                ? "extrema-bucket"
                : line.sources.some((source) => source.sampledAtSource)
                  ? "source"
                  : "none",
          })),
      ),
    };
  }
  async read(input, actor) {
    const q = this.c.queries,
      params = { ...input, actor };
    this.c.check(actor, "research.view");
    if (input.mode === "inspect") {
      const index = await this.inspect(input.provider, input.assetIds, actor);
      return q.page(
        "experiment",
        index.runs,
        params,
        { provider: index.provider, assets: input.assetIds },
        null,
        { provider: index.provider },
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
    const view = this.overview(input.nodeId, actor, input.candidateId);
    const receipts = (items = []) => [
      q.receipt(
        actor,
        "experiment",
        input.nodeId,
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
        { nodeId: input.nodeId, revision: view.revision },
        receipts,
        { nodeId: input.nodeId, revision: view.revision },
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
        { nodeId: input.nodeId, revision: view.revision },
      );
    const run = await this.runSeries(
      { nodeId: input.nodeId, runId: input.runId },
      actor,
      input.candidateId,
      input.blockId,
      input.blockRevision,
    );
    if (input.mode === "metrics")
      return q.page(
        "experiment",
        run.series.map((line) => ({
          key: line.key,
          xKey: line.xKey,
          pointCount: line.points.length,
          sampled: line.sources.some((source) => source.sampledAtSource),
          readHint: {
            tool: "read_experiment",
            mode: "series",
            nodeId: input.nodeId,
            runId: input.runId,
            metric: line.key,
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
        { nodeId: input.nodeId, runId: input.runId },
      );
    const line = run.series.find((line) => line.key === input.metric);
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
    const points = line.points.slice(offset, offset + limit);
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
          pointCount: line.points.length,
          offset,
          nextOffset:
            offset + points.length < line.points.length
              ? offset + points.length
              : null,
          sampled,
        },
        params,
        {
          coverage: {
            complete:
              !sampled && offset === 0 && points.length === line.points.length,
            omissions: [
              ...(points.length === line.points.length ? [] : ["morePoints"]),
              ...(sampled ? ["sourceSampled"] : []),
            ],
          },
        },
      ),
      receipts(),
    );
  }
}
