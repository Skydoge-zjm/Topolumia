export const outputRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Native providers return direct objects, JSON text, or MCP text envelopes. */
export function decodeToolOutput(
  raw: unknown,
  depth = 0,
): { value: unknown; structured: boolean } {
  if (depth > 6)
    return { value: raw, structured: typeof raw === "object" && raw !== null };
  if (typeof raw === "string") {
    const text = raw
      .trim()
      .replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
    try {
      const result = decodeToolOutput(JSON.parse(text), depth + 1);
      return { ...result, structured: true };
    } catch {
      return { value: raw, structured: false };
    }
  }
  const record = outputRecord(raw);
  if (
    record.structuredContent !== undefined &&
    record.structuredContent !== null
  )
    return decodeToolOutput(record.structuredContent, depth + 1);
  if (
    Array.isArray(record.content) &&
    record.content.every((block) => outputRecord(block).type === "text")
  )
    return decodeToolOutput(record.content, depth + 1);
  if (
    Array.isArray(raw) &&
    raw.length &&
    raw.every(
      (block) =>
        outputRecord(block).type === "text" &&
        typeof outputRecord(block).text === "string",
    )
  ) {
    const values = raw.map(
      (block) => decodeToolOutput(outputRecord(block).text, depth + 1).value,
    );
    return values.length === 1
      ? {
          value: values[0],
          structured: typeof values[0] === "object" && values[0] !== null,
        }
      : { value: values, structured: true };
  }
  return { value: raw, structured: raw !== null && typeof raw === "object" };
}
