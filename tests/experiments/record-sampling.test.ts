import test from "node:test";
import assert from "node:assert/strict";
import { downsamplePoints } from "../../src/domain/research/record-sampling.js";

test("display sampling preserves the first and last observation at its smallest budget", () => {
  const points = [{ x: 0, y: 3 }, { x: 1, y: -40 }, { x: 1, y: 90 }, { x: 0, y: 2 }];
  assert.deepEqual(downsamplePoints(points, 2), [{ x: 0, y: 3 }, { x: 0, y: 2 }]);
});

test("extrema sampling keeps narrow peaks and troughs in original observation order", () => {
  const points = [
    { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 70 }, { x: 3, y: 1 },
    { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: -30 }, { x: 4, y: 1 },
    { x: 5, y: 1 }, { x: 6, y: 2 },
  ];
  const sampled = downsamplePoints(points, 6);
  assert.ok(sampled.length <= 6);
  assert.deepEqual(sampled[0], { x: 0, y: 1 });
  assert.deepEqual(sampled.at(-1), { x: 6, y: 2 });
  assert.ok(sampled.some(point => point.y === 70));
  assert.ok(sampled.some(point => point.y === -30));
  assert.ok(sampled.findIndex(point => point.y === 70) < sampled.findIndex(point => point.y === -30));
  for (const point of sampled) assert.ok(points.some(original => original.x === point.x && original.y === point.y));
});

test("flat data respects odd budgets without duplicate observations or mutating source records", () => {
  const points = Array.from({ length: 100 }, (_, id) => ({ x: id % 4, y: 1, id }));
  const sampled = downsamplePoints(points, 7);
  assert.equal(sampled.length, 7);
  assert.equal(new Set(sampled.map(point => point.id)).size, 7);
  assert.equal(sampled[0].id, 0);
  assert.equal(sampled.at(-1)!.id, 99);
  assert.deepEqual(sampled.map(point => point.id), sampled.map(point => point.id).sort((a, b) => a - b));
  sampled[0].y = -1;
  assert.equal(points[0].y, 1);
});

test("uniform sampling selects evenly spaced observations and the global display cap", () => {
  const points = Array.from({ length: 10 }, (_, x) => ({ x, y: x + 10 }));
  assert.deepEqual(downsamplePoints(points, 4, { strategy: "uniform" }), [
    { x: 0, y: 10 }, { x: 3, y: 13 }, { x: 6, y: 16 }, { x: 9, y: 19 },
  ]);
  const large = Array.from({ length: 3000 }, (_, x) => ({ x, y: x % 3 }));
  const bounded = downsamplePoints(large, 10000);
  assert.ok(bounded.length <= 2000);
  assert.equal(bounded[0].x, 0);
  assert.equal(bounded.at(-1)!.x, 2999);
});

test("empty, single and already-small records retain every observation as independent values", () => {
  assert.deepEqual(downsamplePoints([], 2), []);
  const single = [{ x: 3, y: .5 }], copied = downsamplePoints(single, 2);
  assert.deepEqual(copied, [{ x: 3, y: .5 }]);
  copied[0].y = 8;
  assert.equal(single[0].y, .5);
  const reset = [{ x: 9, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }];
  assert.deepEqual(downsamplePoints(reset, 10), reset);
});
