import { describe, expect, it } from "vitest";
import {
  conversationWaypoints,
  navigationExcerpt,
} from "./conversationNavigation";
import type { ConversationItem } from "./agentConversation";

describe("conversation waypoints", () => {
  it("keeps identical questions separate and pairs each with its own final reply", () => {
    const items: ConversationItem[] = [
      { kind: "message", key: "u1", role: "user", text: "Check the evidence" },
      { kind: "reasoning", key: "r", text: "Private intermediate summary" },
      {
        kind: "message",
        key: "progress",
        role: "assistant",
        phase: "commentary",
        text: "Reading",
      },
      {
        kind: "message",
        key: "final",
        role: "assistant",
        phase: "final_answer",
        text: "**Verified** [source](https://example.com)",
      },
      {
        kind: "message",
        key: "late-progress",
        role: "assistant",
        phase: "commentary",
        text: "Late progress",
      },
      { kind: "message", key: "u2", role: "user", text: "Check the evidence" },
      {
        kind: "message",
        key: "answer2",
        role: "assistant",
        text: "Independent second answer",
      },
    ];
    expect(conversationWaypoints(items)).toEqual([
      { key: "u1", text: "Check the evidence", reply: "Verified source" },
      {
        key: "u2",
        text: "Check the evidence",
        reply: "Independent second answer",
      },
    ]);
  });
  it("excludes subagent conversations, tool output and reasoning while retaining unanswered questions", () => {
    const items: ConversationItem[] = [
      { kind: "message", key: "u", role: "user", text: "Question" },
      {
        kind: "subagent",
        key: "child",
        children: [
          {
            kind: "message",
            key: "child-user",
            role: "user",
            text: "Internal task",
          },
          {
            kind: "message",
            key: "child-answer",
            role: "assistant",
            text: "Child answer",
          },
        ],
      },
      { kind: "tool", key: "tool", detail: "Raw output" },
    ];
    expect(conversationWaypoints(items)).toEqual([
      { key: "u", text: "Question", reply: "" },
    ]);
  });
  it("bounds previews and renders Markdown as readable plain text", () => {
    expect(
      navigationExcerpt(
        "## Findings\n- **Evidence** `checked`\n\nConclusion",
        80,
      ),
    ).toBe("Findings Evidence checked Conclusion");
    expect(navigationExcerpt("Long preview text", 8)).toBe("Long pre…");
  });
});
