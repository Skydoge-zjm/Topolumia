/** Bounded display reduction; exact record reads keep all observations. */
export function downsamplePoints<T extends { x: number; y: number }>(
  points: T[],
  maxPoints = 240,
  {
    strategy = "extrema-bucket",
  }: { strategy?: "extrema-bucket" | "uniform" } = {},
): T[] {
  const list = Array.isArray(points) ? points : [];
  const limit = Math.max(2, Math.min(2_000, Number(maxPoints) || 240));
  if (list.length <= limit) return list.map((point) => ({ ...point }));

  if (strategy === "uniform") {
    const selected = [list[0]];
    const stride = (list.length - 1) / (limit - 1);
    for (let index = 1; index < limit - 1; index += 1)
      selected.push(list[Math.round(index * stride)]);
    selected.push(list[list.length - 1]);
    return selected.map((point) => ({ ...point }));
  }

  const interiorBudget = limit - 2;
  const interior = list.slice(1, -1);
  const bucketCount = Math.max(1, Math.ceil(interiorBudget / 2));
  const candidates = [];
  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const start = Math.floor((bucketIndex * interior.length) / bucketCount);
    const end = Math.max(
      start + 1,
      Math.floor(((bucketIndex + 1) * interior.length) / bucketCount),
    );
    const bucket = interior.slice(start, end);
    if (!bucket.length) continue;
    let minIndex = 0;
    let maxIndex = 0;
    for (let index = 1; index < bucket.length; index += 1) {
      if (Number(bucket[index].y) < Number(bucket[minIndex].y))
        minIndex = index;
      if (Number(bucket[index].y) > Number(bucket[maxIndex].y))
        maxIndex = index;
    }
    const range = Math.abs(
      Number(bucket[maxIndex].y) - Number(bucket[minIndex].y),
    );
    candidates.push({ index: start + minIndex + 1, range });
    if (maxIndex !== minIndex)
      candidates.push({ index: start + maxIndex + 1, range });
  }

  const unique = [
    ...new Map(
      candidates.map((candidate) => [candidate.index, candidate]),
    ).values(),
  ];
  let selected = unique;
  if (selected.length > interiorBudget) {
    selected = [...selected]
      .sort((a, b) => b.range - a.range || a.index - b.index)
      .slice(0, interiorBudget);
  } else if (selected.length < interiorBudget) {
    const chosen = new Set(selected.map((candidate) => candidate.index));
    const stride = (list.length - 1) / (interiorBudget + 1);
    for (
      let index = 1;
      selected.length < interiorBudget && index <= interiorBudget;
      index += 1
    ) {
      const candidateIndex = Math.max(
        1,
        Math.min(list.length - 2, Math.round(index * stride)),
      );
      if (chosen.has(candidateIndex)) continue;
      chosen.add(candidateIndex);
      selected.push({ index: candidateIndex, range: 0 });
    }
  }
  selected.sort((a, b) => a.index - b.index);
  return [
    list[0],
    ...selected.map((candidate) => list[candidate.index]),
    list[list.length - 1],
  ].map((point) => ({ ...point }));
}
