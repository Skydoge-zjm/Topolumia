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
function fixture(provider = "codex", configKey = provider) {
  const content =
    provider === "codex"
      ? '# keep\nmodel = "gpt-6-luna"\n[features]\nenabled = true\n'
      : provider === "opencode"
        ? '// keep\n{"model":"lab/gpt-6-luna","permission":{"bash":"ask"},}'
        : '{"model":"gpt-6-luna","env":{"PROVIDER":"lab"}}';
  let document = {
    provider,
    configKey,
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
    onActivity = vi.fn();
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
        disabled={false}
        onActivity={onActivity}
        onSaved={onSaved}
      />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), requests, onSaved, onActivity };
}
async function openSource(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("tab", { name: /^原生文件/ }));
  return screen.getByRole("textbox", {
    name: "配置文件内容",
  }) as HTMLTextAreaElement;
}
async function openCommon(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("tab", { name: "常用设置" }));
}
it.each(["codex", "claude", "opencode"])(
  "preserves the complete native %s file including custom options",
  async (provider) => {
    const f = fixture(provider);
    const editor = await openSource(f.user);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
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
  const field = await openSource(f.user);
  await f.user.clear(field);
  await f.user.click(field);
  await f.user.paste(
    'model = "custom-model"\nmodel_reasoning_effort = "high"\n[features]\nenabled = false\ncustom = [1,2]\n',
  );
  await openCommon(f.user);
  const model = screen.getByRole("combobox", { name: "默认模型" });
  expect(model).toHaveValue("custom-model");
  expect(screen.getByRole("button", { name: "推理强度" })).toHaveTextContent(
    "高",
  );
  await f.user.clear(model);
  await f.user.type(model, "another-model");
  expect(parseConfig("codex", (await openSource(f.user)).value).model).toBe(
    "another-model",
  );
  await openCommon(f.user);
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
  const editor = await openSource(f.user);
  await f.user.clear(editor);
  await f.user.click(editor);
  await f.user.paste(
    'model = "gpt-6-luna"\nmodel_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n',
  );
  await openCommon(f.user);
  const advanced = screen.getByText("更多运行选项");
  expect(screen.queryByLabelText("上下文窗口")).not.toBeVisible();
  await f.user.click(advanced);
  expect(screen.getByLabelText("上下文窗口")).toHaveValue(1000000);
  expect(screen.getByLabelText("自动压缩阈值")).toHaveValue(900000);
  await f.user.clear(screen.getByLabelText("自动压缩阈值"));
  await f.user.type(screen.getByLabelText("自动压缩阈值"), "850000");
  expect(parseConfig("codex", (await openSource(f.user)).value)).toMatchObject({
    model_context_window: 1000000,
    model_auto_compact_token_limit: 850000,
  });
});
it("does not show Codex context controls for Claude", async () => {
  const f = fixture("claude");
  await openCommon(f.user);
  expect(screen.queryByText("更多运行选项")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("上下文窗口")).not.toBeInTheDocument();
});
it("blocks common form edits and saving until invalid native syntax is repaired", async () => {
  const f = fixture();
  const editor = await openSource(f.user);
  await f.user.clear(editor);
  await f.user.click(editor);
  await f.user.paste('model = "unfinished');
  expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  await openCommon(f.user);
  expect(screen.getByRole("button", { name: "推理强度" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("请检查配置语法");
  expect(f.requests).toHaveLength(0);
  const repaired = await openSource(f.user);
  await f.user.clear(repaired);
  await f.user.click(repaired);
  await f.user.paste('model = "repaired"\n');
  await openCommon(f.user);
  expect(screen.getByRole("combobox", { name: "默认模型" })).toHaveValue(
    "repaired",
  );
  expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
});
it("preserves detailed Claude permission rules when changing the default mode", async () => {
  const f = fixture("claude");
  const editor = await openSource(f.user);
  await f.user.clear(editor);
  await f.user.click(editor);
  await f.user.paste(
    '{"model":"gpt-6-luna","permissions":{"allow":["Read"],"deny":["Read(.env)"],"defaultMode":"default"},"env":{"PROVIDER":"lab"}}',
  );
  await openCommon(f.user);
  await f.user.click(screen.getByRole("button", { name: "权限模式" }));
  await f.user.click(screen.getByRole("option", { name: "自动允许文件编辑" }));
  expect(parseConfig("claude", (await openSource(f.user)).value)).toMatchObject(
    {
      permissions: {
        allow: ["Read"],
        deny: ["Read(.env)"],
        defaultMode: "acceptEdits",
      },
      env: { PROVIDER: "lab" },
    },
  );
});
it("edits a schema field across modes and resets the shared draft", async () => {
  const f = fixture();
  await f.user.click(await screen.findByRole("tab", { name: "完整配置项" }));
  await f.user.selectOptions(
    screen.getByRole("combobox", { name: "配置字段" }),
    "features",
  );
  expect(screen.getByText("Runtime feature flags")).toBeVisible();
  const field = screen.getByRole("textbox", { name: "字段值（JSON）" });
  await f.user.clear(field);
  await f.user.paste('{"enabled": false, "custom": 1}');
  const editor = await openSource(f.user);
  expect(parseConfig("codex", editor.value).features).toEqual({
    enabled: false,
    custom: 1,
  });
  expect(f.onActivity).toHaveBeenLastCalledWith({ dirty: true, busy: false });
  await f.user.click(screen.getByRole("button", { name: "重置修改" }));
  expect(parseConfig("codex", editor.value).features).toEqual({
    enabled: true,
  });
  expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
});

it("can unset the native model or enter a new explicit model", async () => {
  const f = fixture();
  await openCommon(f.user);
  await f.user.click(
    screen.getByRole("radio", { name: "跟随本机运行时默认值" }),
  );
  expect(
    parseConfig("codex", (await openSource(f.user)).value),
  ).not.toHaveProperty("model");
  await openCommon(f.user);
  await f.user.click(screen.getByRole("radio", { name: "指定模型" }));
  expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  await f.user.type(
    screen.getByRole("combobox", { name: "默认模型" }),
    "explicit-model",
  );
  await f.user.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() => expect(f.onSaved).toHaveBeenCalledOnce());
  expect(parseConfig("codex", f.requests[0].content).model).toBe(
    "explicit-model",
  );
});

it("edits V2 default permission without deleting ordered exceptions or provider settings", async () => {
  const f = fixture("opencode", "opencode-v2");
  const source = await openSource(f.user);
  const custom = {
    model: { providerID: "lab", model: "reasoner", variant: "high" },
    permissions: [
      { action: "*", resource: "*", effect: "ask" },
      { action: "shell", resource: "git push *", effect: "deny" },
    ],
    providers: { lab: { settings: { baseURL: "https://fixture.invalid" } } },
  };
  await f.user.clear(source);
  await f.user.click(source);
  await f.user.paste(JSON.stringify(custom));
  await openCommon(f.user);
  expect(screen.getByRole("combobox", { name: "默认模型" })).toHaveValue(
    "lab/reasoner#high",
  );
  await f.user.click(screen.getByRole("button", { name: "工具权限" }));
  await f.user.click(screen.getByRole("option", { name: "自动允许" }));
  const parsed = JSON.parse((await openSource(f.user)).value);
  expect(parsed.permissions).toEqual([
    { action: "*", resource: "*", effect: "allow" },
    custom.permissions[1],
  ]);
  expect(parsed.providers).toEqual(custom.providers);
  expect(parsed.model).toEqual(custom.model);
  await f.user.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() => expect(f.onSaved).toHaveBeenCalled());
});
