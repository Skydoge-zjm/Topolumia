// Share a small process budget across projects and environment inspections.
let running = 0;
const waiting: Array<() => void> = [];
export async function withEnvironmentCapacity<T>(
  execute: () => Promise<T>,
): Promise<T> {
  if (running >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  else running++;
  try {
    return await execute();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}
