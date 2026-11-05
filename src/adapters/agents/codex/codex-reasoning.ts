// Native Codex reasoning items can contain multiple summary paragraphs and a
// separate text channel. Preserve those native boundaries.
export function codexReasoningParts(item) {
  const parts = [];
  for (const [channel, value] of [["summary", item.summary ?? item.summaryText], ["content", item.content]]) {
    const entries = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    entries.forEach((entry, index) => {
      const text = typeof entry === "string" ? entry : entry?.text;
      if (typeof text === "string" && text.trim()) parts.push({ channel, index, text });
    });
  }
  return parts;
}
