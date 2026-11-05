import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentApprovalCard } from "./AgentApprovalCard";
import { normalizeConversation } from "@/features/agents/conversation/model/agentConversation";
import type { AgentApproval } from "@domain/agents/agent-approval";
import type { AgentEvent } from "@/shared/types/api";

afterEach(cleanup);

it("blocks elevated grants without role authority while keeping rejection available", () => {
  render(<AgentApprovalCard approval={approval({ category: "command", risk: "elevated" })} en onApproval={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Allow for session" })).toBeDisabled();
  expect(screen.getByRole("button", { name: /^Reject$/ })).toBeEnabled();
  expect(screen.getByRole("status").textContent).toMatch(/high-risk tool approval/);
});

it("allows an ordinary project edit once and restricts broader grants", () => {
  render(<AgentApprovalCard approval={approval({ category: "file-change", command: undefined, risk: "project-write" })} en onApproval={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Allow once" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Allow for session" })).toBeDisabled();
});
const approval = (extra: Partial<AgentApproval> = {}): AgentApproval => ({
  requestId: "a",
  status: "pending",
  toolName: "Bash",
  command: "python experiment.py",
  cwd: "E:/Research",
  options: [
    { optionId: "once", kind: "allow_once", scope: "once" },
    { optionId: "always", kind: "allow_session", scope: "session" },
    {
      optionId: "rule",
      kind: "allow_always",
      scope: "persistent",
      description: "Bash(python experiment.py)",
    },
    { optionId: "reject", kind: "reject_once", scope: "once" },
  ],
  ...extra,
});

it("presents native scopes, preserves exact native option IDs and discloses saved rules separately", async () => {
  const onApproval = vi.fn();
  render(
    <AgentApprovalCard canApproveHighRisk
      approval={approval()}
      en={false}
      onApproval={onApproval}
    />,
  );
  expect(screen.getByText("python experiment.py")).toBeVisible();
  expect(screen.getByText("E:/Research")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "允许并保存规则" }),
  ).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "本会话允许" }));
  await waitFor(() =>
    expect(onApproval).toHaveBeenCalledWith("a", {
      decision: "allow",
      optionId: "always",
    }),
  );
  fireEvent.click(screen.getByText("保存授权规则…"));
  expect(screen.getByText("Bash(python experiment.py)")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "允许并保存规则" }));
  await waitFor(() =>
    expect(onApproval).toHaveBeenLastCalledWith("a", {
      decision: "allow",
      optionId: "rule",
    }),
  );
});

it("sends only selected requested permission categories and disables an empty grant", async () => {
  const onApproval = vi.fn();
  render(
    <AgentApprovalCard canApproveHighRisk
      en
      approval={approval({
        category: "permissions",
        permissions: {
          network: { enabled: true },
          fileSystem: { write: ["E:/Output"] },
        },
      })}
      onApproval={onApproval}
    />,
  );
  fireEvent.click(screen.getByLabelText("File system access"));
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await waitFor(() =>
    expect(onApproval).toHaveBeenCalledWith("a", {
      decision: "allow",
      optionId: "once",
      permissionKeys: ["network"],
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Allow once" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByLabelText("Network access"));
  expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
});

it("does not invent allow options and renders withdrawn history without action buttons", () => {
  const { rerender } = render(
    <AgentApprovalCard canApproveHighRisk
      en={false}
      approval={approval({
        options: [{ optionId: "no", kind: "reject_once" }],
      })}
      onApproval={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: /允许/ })).toBeNull();
  rerender(
    <AgentApprovalCard canApproveHighRisk
      en={false}
      approval={approval({ status: "resolved", decision: "expired" })}
      onApproval={vi.fn()}
    />,
  );
  expect(screen.getByText("已失效")).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
});

it("explains Claude's session edit mode as a mode change with a distinct action", () => {
  const onApproval = vi.fn();
  render(
    <AgentApprovalCard canApproveHighRisk
      en={false}
      approval={approval({
        options: [
          {
            optionId: "edits",
            kind: "allow_session",
            scope: "session",
            mode: "acceptEdits",
            description: "本会话后续所有文件写入与编辑将自动批准。",
          },
        ],
      })}
      onApproval={onApproval}
    />,
  );
  expect(
    screen.getByText("本会话后续所有文件写入与编辑将自动批准。"),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "本会话自动允许编辑" }));
  expect(onApproval).toHaveBeenCalledWith("a", {
    decision: "allow",
    optionId: "edits",
  });
});

it("locks each request separately, reports its own failure and allows retry", async () => {
  let fail!: (error: Error) => void;
  const onApproval = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
  );
  render(
    <>
      <AgentApprovalCard canApproveHighRisk en approval={approval()} onApproval={onApproval} />
      <AgentApprovalCard canApproveHighRisk
        en
        approval={approval({ requestId: "b" })}
        onApproval={vi.fn()}
      />
    </>,
  );
  const buttons = screen.getAllByRole("button", { name: "Allow once" });
  fireEvent.click(buttons[0]);
  fireEvent.click(buttons[0]);
  expect(onApproval).toHaveBeenCalledTimes(1);
  expect(buttons[0]).toBeDisabled();
  expect(buttons[1]).toBeEnabled();
  fail(new Error("Transport offline; retry"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Transport offline; retry",
  );
  await waitFor(() => expect(buttons[0]).toBeEnabled());
});

it("normalizes structured approval details and actual outcomes without joining separate native requests", () => {
  const event = (
    cursor: number,
    type: string,
    payload: Record<string, unknown>,
  ): AgentEvent => ({
    id: `e${cursor}`,
    sessionId: "s",
    turnId: "t",
    cursor,
    type,
    payload,
    occurredAt: "",
  });
  const items = normalizeConversation([
    event(1, "approval.requested", { ...approval(), status: undefined }),
    event(2, "approval.resolved", {
      requestId: "a",
      decision: "allow",
      optionId: "always",
      selectedScope: "session",
    }),
    event(3, "approval.requested", {
      ...approval({ requestId: "b" }),
      status: undefined,
    }),
    event(4, "turn.cancelled", {}),
  ]);
  expect(items).toHaveLength(2);
  expect(items[0].approval).toMatchObject({
    decision: "allow",
    selectedScope: "session",
    command: "python experiment.py",
    status: "resolved",
  });
  expect(items[1].approval).toMatchObject({
    requestId: "b",
    decision: "cancelled",
    status: "resolved",
  });
});
