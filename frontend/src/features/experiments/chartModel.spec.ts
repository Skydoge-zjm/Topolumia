import { expect, it } from "vitest";
import {
  buildFacetedData,
  nearestPoint,
  pointIndex,
  type RecordLine,
} from "./chartModel";

it("keeps disjoint run coordinates linear in the number of recorded display points", () => {
  const lines = Array.from(
    { length: 200 },
    (_, run) =>
      ({
        points: Array.from({ length: 200 }, (_, step) => ({
          x: step * 200 + run,
          y: step,
        })),
      }) as RecordLine,
  );
  const data = buildFacetedData(lines);
  expect(
    data
      .slice(1)
      .reduce((sum, line) => sum + line[0].length + line[1].length, 0),
  ).toBe(80000);
  expect(data[200][0][199]).toBe(39999);
});

it("keeps repeated values and breaks the display path at a reset without changing raw points", () => {
  const points = [
    { x: 0, y: 1 },
    { x: 2, y: 2 },
    { x: 2, y: 3 },
    { x: 0, y: 4 },
    { x: 1, y: 5 },
  ];
  const before = structuredClone(points),
    data = buildFacetedData([{ points } as RecordLine]);
  expect(data[1]).toEqual([
    [0, 2, 2, 2, 0, 1],
    [1, 2, 3, null, 4, 5],
  ]);
  expect(points).toEqual(before);
  const locate = pointIndex(...data[1]);
  expect(locate(1)).toBe(5);
  expect(locate(-1)).toBeNull();
  expect(nearestPoint(points, 1)).toEqual({ x: 1, y: 5 });
  expect(nearestPoint(points, 9)).toBeNull();
});
