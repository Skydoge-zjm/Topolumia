import { expect, it } from "vitest";
import { createConversationProjector } from "./conversationProjector";
import type { AgentEvent } from "@/shared/types/api";

it("reuses completed rows while replacing only the changing block and preserves same-length corrections", () => {
  const event = (cursor: number, text: string): AgentEvent => ({
    id: `e${cursor}`,
    cursor,
    sessionId: "s",
    turnId: "t",
    occurredAt: "",
    type: "assistant.message.completed",
    payload: { blockId: `b${cursor}`, text },
  });
  const project = createConversationProjector(),
    first = [event(1, "Fixed"), event(2, "First")];
  const a = project(first),
    b = project([
      first[0],
      { ...first[1], payload: { ...first[1].payload, text: "Other" } },
    ]);
  expect(a[0]).toBe(b[0]);
  expect(a[1]).not.toBe(b[1]);
  expect(b[1].text).toBe("Other");
  expect(project([first[0], first[1]]).map((row) => row.key)).toEqual(
    a.map((row) => row.key),
  );
});
