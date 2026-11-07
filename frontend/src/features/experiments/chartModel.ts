export type RecordLine = {
  nodeId: string;
  nodeName: string;
  runId: string;
  runLabel: string;
  key: string;
  xKey: string;
  points: { x: number; y: number }[];
  pointCount: number;
  sampled: boolean;
  contentVersion?: string;
  sources: any[];
};

/** Mirrors tokens.css --chart-1…8; canvas needs resolved colours, not var() strings. */
export const CHART_COLORS = [
  "#178d70",
  "#2563eb",
  "#b45309",
  "#9333ea",
  "#b3261e",
  "#0f766e",
  "#4d6b2f",
  "#7c3f58",
  "#0072b2",
  "#d55e00",
  "#009e73",
  "#cc79a7",
  "#e69f00",
  "#56b4e9",
  "#6a3d9a",
  "#a6761d",
];
export const AXIS_INK = "#526c60";
export const GRID_INK = "#dce5df";

/** Stable across blocks, dialogs and reloads: the run identity, not its position, picks the colour. */
export function runColor(nodeId: string, runId: string) {
  let hash = 2166136261;
  for (const char of nodeId + "\u0000" + runId) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % CHART_COLORS.length;
}
export const runKey = (line: { nodeId: string; runId: string }) =>
  JSON.stringify([line.nodeId, line.runId]);
export const seriesKey = (line: RecordLine) => runKey(line) + ":" + line.xKey;

export const format = (value: number) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 }).format(
        value,
      )
    : "—";
export const formatValue = (value: number | null) =>
  value === null ? "—" : format(value);

export function tickFormat(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6 || magnitude < 1e-3)
    return value.toExponential(1).replace("e+", "e");
  const digits = Math.max(0, 3 - 1 - Math.floor(Math.log10(magnitude)));
  return Number(value.toFixed(Math.min(6, digits))).toString();
}

/** 1/2/5 × 10ⁿ steps so ticks read as round numbers instead of raw min/max fractions. */
export function niceTicks(low: number, high: number, target = 5) {
  if (!Number.isFinite(low) || !Number.isFinite(high) || high === low)
    return [low];
  const raw = (high - low) / Math.max(2, target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10]
      .map((factor) => factor * magnitude)
      .find((candidate) => candidate >= raw) ?? raw;
  const ticks: number[] = [];
  for (
    let value = Math.ceil(low / step) * step;
    value <= high + step * 1e-9;
    value += step
  )
    ticks.push(Number(value.toPrecision(12)));
  return ticks.length ? ticks : [low, high];
}

/** Group the plot's flat series list into one stable array per metric. */
export function seriesByMetric(series: RecordLine[]) {
  const groups = new Map<string, RecordLine[]>();
  for (const line of series)
    groups.set(line.key, [...(groups.get(line.key) ?? []), line]);
  return [...groups];
}

export function lineLabel(line: RecordLine, multiNode: boolean) {
  return (multiNode ? line.nodeName + " · " : "") + line.runLabel;
}

/**
 * uPlot needs one shared x axis. Series recorded on different steps are aligned
 * onto the union of their x values; null marks a step a run never recorded, so
 * uPlot leaves a gap instead of interpolating across it.
 */
export function buildData(lines: RecordLine[]): (number | null)[][] {
  const xs = [
    ...new Set(lines.flatMap((line) => line.points.map((point) => point.x))),
  ].sort((a, b) => a - b);
  return [
    xs,
    ...lines.map((line) => {
      const points = new Map(line.points.map((point) => [point.x, point.y]));
      return xs.map((x) => (points.has(x) ? points.get(x)! : null));
    }),
  ];
}

export function nearestValue(
  column: (number | null)[],
  index: number,
): number | null {
  for (let offset = 0; offset < column.length; offset += 1) {
    const left = column[index - offset],
      right = column[index + offset];
    if (left !== null && left !== undefined) return left;
    if (offset > 0 && right !== null && right !== undefined) return right;
  }
  return null;
}
