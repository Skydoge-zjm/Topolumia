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
const numberFormat = new Intl.NumberFormat(undefined, {
  maximumSignificantDigits: 5,
});
export const format = (value: number) =>
  Number.isFinite(value) ? numberFormat.format(value) : "—";
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
  for (const line of series) {
    let group = groups.get(line.key);
    if (!group) groups.set(line.key, (group = []));
    group.push(line);
  }
  return [...groups];
}

export function lineLabel(line: RecordLine, multiNode: boolean) {
  return (multiNode ? line.nodeName + " · " : "") + line.runLabel;
}

const orderedPoints = new WeakMap<object, { x: number; y: number }[]>();
export function nearestPoint(
  points: { x: number; y: number }[],
  value: number,
) {
  if (!points.length) return null;
  let ordered = orderedPoints.get(points);
  if (!ordered) {
    ordered = points.every(
      (point, index) => !index || point.x >= points[index - 1].x,
    )
      ? points
      : [...points].sort((a, b) => a.x - b.x);
    orderedPoints.set(points, ordered);
  }
  points = ordered;
  if (value < points[0].x || value > points[points.length - 1].x) return null;
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].x < value) low = middle + 1;
    else high = middle;
  }
  const right = points[low];
  const left = points[Math.max(0, low - 1)];
  return Math.abs(left.x - value) <= Math.abs(right.x - value) ? left : right;
}

/** Cache sorted indices once so pointer handling uses binary search. */
export function pointIndex(xs: number[], ys: (number | null)[]) {
  const indices = xs
    .map((_, index) => index)
    .filter((index) => ys[index] !== null)
    .sort((a, b) => xs[a] - xs[b]);
  return (x: number) => {
    if (
      !indices.length ||
      x < xs[indices[0]] ||
      x > xs[indices[indices.length - 1]]
    )
      return null;
    let low = 0,
      high = indices.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (xs[indices[middle]] < x) low = middle + 1;
      else high = middle;
    }
    const a = indices[Math.max(0, low - 1)],
      b = indices[low];
    return Math.abs(xs[a] - x) <= Math.abs(xs[b] - x) ? a : b;
  };
}

/** Per-series coordinates avoid a runs × union-of-steps matrix of mostly nulls. */
export function buildFacetedData(
  lines: RecordLine[],
): [number[], (number | null)[]][] {
  return [
    [[], []],
    ...lines.map((line): [number[], (number | null)[]] => {
      const xs: number[] = [],
        ys: (number | null)[] = [];
      for (let index = 0; index < line.points.length; index++) {
        const point = line.points[index];
        if (index && point.x < line.points[index - 1].x) {
          xs.push(line.points[index - 1].x);
          ys.push(null);
        }
        xs.push(point.x);
        ys.push(point.y);
      }
      return [xs, ys];
    }),
  ];
}
