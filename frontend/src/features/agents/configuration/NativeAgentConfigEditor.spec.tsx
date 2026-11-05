import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { NativeAgentConfigEditor } from "./NativeAgentConfigEditor";
import type { ConfiguredAgent } from "./AgentConfigurationPage";
import { parseConfig } from "./nativeConfigModel";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture(provider = "codex") {
  const content =
    provider === "codex"
      ? '# keep\nmodel = "gpt-6-luna"\n[features]\nenabled = true\n'
      : provider === "opencode"
        ? '// keep\n{"model":"lab/gpt-6-luna","permission":{"bash":"ask"},}'
        : '{"model":"gpt-6-luna","env":{"PROVIDER":"lab"}}';
  let document = {
    provider,
    filename:
      provider === "codex"
        ? "config.toml"
        : provider === "claude"
          ? "settings.json"
          : "opencode.jsonc",
    format: provider === "codex" ? "toml" : "json",
    path: `application-data/${provider}/config`,
    revision: "sha256:" + "a".repeat(64),
    valid: true,
    validation: null,
    content,
    schema: {
      properties: {
        model: { type: "string" },
        features: { type: "object", description: "Runtime feature flags" },
        hooks: { type: "object", description: "Lifecycle hooks" },
      },
    },
    docsUrl: "https://example.com/docs",
    schemaUrl: "https://example.com/schema",
  };
  const requests: any[] = [],
    onSaved = vi.fn(),
    onClose = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options: RequestInit = {}) => {
      if (options.method === "PUT") {
        const input = JSON.parse(String(options.body));
        requests.push(input);
        document = {
          ...document,
          content: input.content,
          revision: "sha256:" + "b".repeat(64),
        };
      }
      return Response.json(document);
    }),
  );
  const agent = {
    id: provider,
    provider,
    label: provider,
    models: [{ id: "gpt-6-luna", label: "Luna" }],
  } as ConfiguredAgent;
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <NativeAgentConfigEditor
        agent={agent}
        en={false}
        onClose={onClose}
        onSaved={onSaved}
      />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), requests, onSaved, onClose };
}
it.each(["codex", "claude", "opencode"])(
  "preserves the complete native %s file including custom options",
  async (provider) => {
    const f = fixture(provider);
    const editor = await screen.findByLabelText("配置文件内容");
    expect(
      screen.queryByRole("button", { name: "全部配置项" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "原生文件" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(`application-data/${provider}/config`),
    ).not.toBeInTheDocument();
    const content =
      provider === "codex"
        ? '# preserved comment\nmodel = "gpt-6-luna"\n[future_config]\nvalue = "example"\n'
        : '{"model":"gpt-6-luna","futureConfig":{"enabled":true}}';
    await f.user.clear(editor);
    await f.user.click(editor);
    await f.user.paste(content);
    await f.user.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(f.onSaved).toHaveBeenCalled());
    expect(f.requests[0].content).toBe(content);
    expect(f.requests[0].expectedRevision).toBe("sha256:" + "a".repeat(64));
  },
);
it("keeps the common form and native text in sync while preserving custom nested options", async () => {
  const f = fixture();
  const field = await screen.findByLabelText("配置文件内容");
  await f.user.clear(field);
  await f.user.click(field);
  await f.user.paste(
    'model = "custom-model"\nmodel_reasoning_effort = "high"\n[features]\nenabled = false\ncustom = [1,2]\n',
  );
  const model = screen.getByRole("combobox", { name: "默认模型" });
  expect(model).toHaveValue("custom-model");
  expect(screen.getByRole("button", { name: "推理强度" })).toHaveTextContent(
    "高",
  );
  await f.user.clear(model);
  await f.user.type(model, "another-model");
  expect(parseConfig("codex", (field as HTMLTextAreaElement).value).model).toBe(
    "another-model",
  );
  await f.user.click(screen.getByRole("button", { name: "推理强度" }));
  await f.user.click(screen.getByRole("option", { name: "中" }));
  await f.user.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() => expect(f.requests).toHaveLength(1));
  expect(
    parseConfig("codex", f.requests[0].content).model_reasoning_effort,
  ).toBe("medium");
  expect(parseConfig("codex", f.requests[0].content).features).toEqual({
    enabled: false,
    custom: [1, 2],
  });
});
it("shows Codex context controls only in the collapsed advanced section", async () => {
  const f = fixture();
  const editor = await screen.findByLabelText("配置文件内容");
  await f.user.clear(editor);
  await f.user.click(editor);
  await f.user.paste(
    'model = "gpt-6-luna"\nmodel_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n',
  );
  const advanced = screen.getByText("Codex 高级设置");
  expect(screen.queryByLabelText("上下文窗口")).not.toBeVisible();
  await f.user.click(advanced);
  expect(screen.getByLabelText("上下文窗口")).toHaveValue(1000000);
  expect(screen.getByLabelText("自动压缩阈值")).toHaveValue(900000);
  await f.user.clear(screen.getByLabelText("自动压缩阈值"));
  await f.user.type(screen.getByLabelText("自动压缩阈值"), "850000");
  expect(
    parseConfig("codex", (editor as HTMLTextAreaElement).value),
  ).toMatchObject({
    model_context_window: 1000000,
    model_auto_compact_token_limit: 850000,
  });
});
it("does not show Codex context controls for Claude", async () => {
  fixture("claude");
  await screen.findByLabelText("配置文件内容");
  expect(screen.queryByText("Codex 高级设置")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("上下文窗口")).not.toBeInTheDocument();
});
it("blocks common form edits and saving until invalid native syntax is repaired", async () => {
  const f = fixture();
  const editor = await screen.findByLabelText("配置文件内容");
  await f.user.clear(editor);
  await f.user.click(editor);
  await f.user.paste('model = "unfinished');
  expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "默认模型" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "推理强度" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("请检查配置语法");
  expect(f.requests).toHaveLength(0);
  await f.user.clear(editor);
  await f.user.click(editor);
  await f.user.paste('model = "repaired"\n');
  expect(screen.getByRole("combobox", { name: "默认模型" })).toHaveValue(
    "repaired",
  );
  expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
});
it("preserves detailed Claude permission rules when changing the default mode", async () => {
  const f = fixture("claude");
  const editor = await screen.findByLabelText("配置文件内容");
  await f.user.clear(editor);
  await f.user.click(editor);
  await f.user.paste(
    '{"model":"gpt-6-luna","permissions":{"allow":["Read"],"deny":["Read(.env)"],"defaultMode":"default"},"env":{"PROVIDER":"lab"}}',
  );
  await f.user.click(screen.getByRole("button", { name: "权限模式" }));
  await f.user.click(screen.getByRole("option", { name: "自动允许文件编辑" }));
  expect(
    parseConfig("claude", (editor as HTMLTextAreaElement).value),
  ).toMatchObject({
    permissions: {
      allow: ["Read"],
      deny: ["Read(.env)"],
      defaultMode: "acceptEdits",
    },
    env: { PROVIDER: "lab" },
  });
});
it("protects unsaved native edits when closing", async () => {
  const f = fixture();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const editor = await screen.findByLabelText("配置文件内容");
  await f.user.click(editor);
  await f.user.paste("\n# unsaved\n");
  await f.user.click(screen.getByRole("button", { name: "取消" }));
  expect(confirm).toHaveBeenCalled();
  expect(f.onClose).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await f.user.click(screen.getByRole("button", { name: "关闭配置" }));
  expect(f.onClose).toHaveBeenCalledTimes(1);
  confirm.mockRestore();
});
