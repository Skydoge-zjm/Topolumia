import { parentPort } from "node:worker_threads";
import { existsSync } from "node:fs";
import { writeFile, readFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ExperimentRecordReader } from "./record-reader.js";
import { downsamplePoints } from "../../../domain/experiments/experiment-domain.js";
import {
  importTablePreview,
  parseXlsxTable,
} from "../../topology/table-importers.js";

const tableBuffers = new Map<string, Buffer>();
let tableBufferBytes = 0;
const tableResults = new Map<string, { value: any; bytes: number }>();
let tableResultBytes = 0;

let reader: ExperimentRecordReader;
const assets = new Map<string, any>();
function initialize(root, pythonCommand) {
  if (reader) {
    reader.options.pythonCommand = pythonCommand;
    return;
  }
  reader = new ExperimentRecordReader(
    {
      assets: {
        root,
        file: (asset) => asset.file,
        assert: (id) => assets.get(id),
      },
    },
    { pythonCommand },
  );
}
const summaries = new WeakMap<object, any>();
const sampledLines = new WeakMap<object, { limit: number; points: any[] }>();
const directories = new WeakMap<object, Map<string, Map<string, any[]>>>();
function pointDirectory(index) {
  let result = directories.get(index);
  if (!result) {
    result = new Map(
      index.runs.map((run) => [
        run.sourceId,
        new Map(
          run.series.map((line) => [
            JSON.stringify([line.key, line.xKey ?? "step"]),
            line.points,
          ]),
        ),
      ]),
    );
    directories.set(index, result);
  }
  return result;
}
function summary(index) {
  let result = summaries.get(index);
  if (!result) {
    result = {
      schemaVersion: index.schemaVersion,
      provider: index.provider,
      checksum: index.checksum,
      contentVersion: index.contentVersion,
      runs: index.runs.map((run) => ({
        sourceId: run.sourceId,
        label: run.label,
        status: run.status,
        series: run.series.map(({ points, ...line }) => ({
          ...line,
          pointCount: points.length,
        })),
      })),
    };
    summaries.set(index, result);
  }
  return result;
}
async function load(asset, provider) {
  assets.set(asset.id, asset);
  if (assets.size > 512) assets.delete(assets.keys().next().value!);
  const file = reader.indexPath(asset, provider);
  return existsSync(file)
    ? reader.index(asset.id, provider, {})
    : reader.process(asset, provider);
}
async function execute(input) {
  initialize(input.root, input.pythonCommand);
  if (input.action === "close") {
    await reader.close();
    return null;
  }
  if (input.action === "table") {
    const asset = input.asset,
      key = asset.file + ":" + asset.checksum;
    if (!existsSync(asset.file))
      throw Object.assign(new Error("资产原文件不可用。"), {
        code: "ASSET_UNAVAILABLE",
        status: 404,
      });
    const resultKey = key + ":" + JSON.stringify(input.selection ?? null);
    const cached = tableResults.get(resultKey);
    if (cached) {
      tableResults.delete(resultKey);
      tableResults.set(resultKey, cached);
      return cached.value;
    }
    let bytes = tableBuffers.get(key);
    if (!bytes) {
      bytes = await readFile(asset.file);
      if (bytes.length <= 8 * 1024 * 1024) {
        tableBuffers.set(key, bytes);
        tableBufferBytes += bytes.length;
        while (tableBufferBytes > 8 * 1024 * 1024) {
          const oldest = tableBuffers.keys().next().value!;
          tableBufferBytes -= tableBuffers.get(oldest)!.length;
          tableBuffers.delete(oldest);
        }
      }
    }
    const selection = input.selection;
    const value =
      selection && /\.xlsx$/i.test(asset.originalName)
        ? await parseXlsxTable(bytes, {
            sheetName: selection.sheet,
            range: {
              offset: selection.rowOffset ?? 0,
              limit: selection.rowLimit ?? 20,
              columnKeys: selection.columnKeys,
            },
          })
        : await importTablePreview(
            bytes,
            asset.originalName,
            asset.mediaType,
            selection
              ? {
                  range: {
                    offset: selection.rowOffset ?? 0,
                    limit: selection.rowLimit ?? 20,
                    columnKeys: selection.columnKeys,
                  },
                }
              : {},
          );
    const size = Buffer.byteLength(JSON.stringify(value));
    if (size <= 4 * 1024 * 1024) {
      tableResults.set(resultKey, { value, bytes: size });
      tableResultBytes += size;
      while (tableResultBytes > 4 * 1024 * 1024 || tableResults.size > 128) {
        const oldest = tableResults.keys().next().value!;
        tableResultBytes -= tableResults.get(oldest)!.bytes;
        tableResults.delete(oldest);
      }
    }
    return value;
  }
  if (input.action === "ensure") {
    const index = await load(input.asset, input.provider);
    const result = summary(index);
    const file =
      reader.indexPath(input.asset, input.provider) + ".manifest.json";
    const temporary = file + "." + randomUUID();
    await writeFile(temporary, JSON.stringify(result));
    await rename(temporary, file);
    return result;
  }
  if (input.action === "select") {
    const result = [];
    const loaded = new Map<string, any>();
    for (const query of input.queries) {
      const parts = [],
        slices = [];
      let pointCount = 0;
      const offset = query.offset ?? 0,
        end = offset + (query.limit ?? 100);
      for (const segment of query.segments) {
        let segmentPoints;
        if (segment.points) segmentPoints = segment.points;
        else {
          const key = segment.provider + ":" + segment.asset.id;
          let index = loaded.get(key);
          if (!index) {
            index = await load(segment.asset, segment.provider);
            loaded.set(key, index);
          }
          segmentPoints =
            pointDirectory(index)
              .get(segment.sourceId)
              ?.get(JSON.stringify([query.key, query.xKey])) ?? [];
        }
        if (query.maxPoints !== undefined) parts.push(segmentPoints);
        else if (pointCount < end && pointCount + segmentPoints.length > offset)
          slices.push(
            segmentPoints.slice(
              Math.max(0, offset - pointCount),
              end - pointCount,
            ),
          );
        pointCount += segmentPoints.length;
      }
      let selected;
      if (query.maxPoints !== undefined) {
        // Flatten multiple archives once; exact range reads never copy an entire line.
        const points = parts.length === 1 ? parts[0] : parts.flat();
        const cached = sampledLines.get(points);
        selected =
          cached?.limit === query.maxPoints
            ? cached.points
            : downsamplePoints(points, query.maxPoints);
        if (!cached || cached.limit !== query.maxPoints)
          sampledLines.set(points, {
            limit: query.maxPoints,
            points: selected,
          });
      } else selected = slices.flat();
      result.push({
        points: selected,
        pointCount,
      });
    }
    return result;
  }
  throw new Error("Unknown record worker task");
}
let queue = Promise.resolve();
parentPort!.on("message", (input) => {
  queue = queue.then(async () => {
    try {
      parentPort!.postMessage({ id: input.id, value: await execute(input) });
    } catch (error) {
      parentPort!.postMessage({
        id: input.id,
        error: {
          message: error.message,
          code: error.code,
          status: error.status,
        },
      });
    }
  });
});
