import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../../src/config.js";
import {
  UserSettingsStore,
  applyUserSettings,
} from "../../src/services/platform/user-settings-store.js";
import { ToolEnvironmentService } from "../../src/services/environments/tool-environment-service.js";

async function waitFor(
  read,
  predicate = (value) => value.status === "completed",
) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(5);
  }
  throw new Error("Diagnostic fixture did not settle");
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-catalog-"));
  const prefixes = [
    path.join(root, "base"),
    path.join(root, "env with spaces"),
    path.join(root, "other"),
  ];
  for (const prefix of prefixes) {
    const executable = path.join(
      prefix,
      process.platform === "win32" ? "python.exe" : "bin/python",
    );
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");
  }
  const venv = path.join(root, ".venv");
  const venvPython = path.join(
    venv,
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  await mkdir(path.dirname(venvPython), { recursive: true });
  await writeFile(venvPython, "fixture");
  await writeFile(path.join(venv, "pyvenv.cfg"), "uv = 0.9.0\n");
  const config = await loadConfig({
    project: { root },
    filesystem: { roots: ["."] },
    toolCommands: {
      conda: process.execPath,
      cuda: "/fixture/nvcc",
      nvidia: "/fixture/nvidia",
    },
    researchEnvironment: {
      kind: "conda",
      prefix: prefixes[1],
      pythonCommand: "python",
    },
  });
  const settings = new UserSettingsStore({
    filePath: path.join(root, "settings.json"),
    config,
  });
  await settings.initialize();
  const calls = [];
  let hold = null;
  let service;
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "info")
      return {
        ok: true,
        stdout: JSON.stringify({
          conda_version: "26.1.0",
          root_prefix: prefixes[0],
          envs: prefixes,
          channels: ["private-channel-secret"],
        }),
        stderr: "",
      };
    if (args[0] === "list") {
      await delay(5);
      return {
        ok: true,
        stdout: JSON.stringify([
          {
            name: "openssl",
            version: "3.4.0",
            channel: "https://private-token@example.test",
          },
          ...Array.from({ length: 122 }, (_, index) => ({
            name: `package-${String(index).padStart(3, "0")}`,
            version: `${index}.0.0`,
            channel: index % 2 ? "pypi" : "conda-forge",
          })),
        ]),
        stderr: "",
      };
    }
    const mode = args.at(-1);
    if (
      ![
        "identity",
        "packages",
        "package_inventory",
        "torch",
        "jax",
        "tensorflow",
      ].includes(mode)
    )
      return { ok: false, stdout: "", stderr: "" };
    const conda = args.includes("--prefix");
    const prefix = conda
      ? args[args.indexOf("--prefix") + 1]
      : command === venvPython
        ? venv
        : prefixes[0];
    if (hold && prefix === prefixes[1] && mode === "packages") await hold;
    const python = {
      executable: conda
        ? path.join(
            prefix,
            process.platform === "win32" ? "python.exe" : "bin/python",
          )
        : command,
      prefix,
      basePrefix: prefixes[0],
      version: prefix === prefixes[2] ? "3.13.2" : "3.12.8",
      kind:
        conda || command === "python" || command === "python3"
          ? "conda"
          : "venv",
    };
    const result =
      mode === "identity"
        ? { status: "ready", python }
        : mode === "packages"
          ? {
              status: "ready",
              python,
              packages: { wandb: prefix === prefixes[2] ? "0.20.0" : "0.18.0" },
              executables: {},
            }
          : mode === "package_inventory"
            ? {
                status: "ready",
                python,
                items: [
                  { name: "wandb", version: "0.20.0", source: "python" },
                  { name: "numpy", version: "2.1.0", source: "python" },
                ],
              }
            : { status: "not_installed" };
    return {
      ok: true,
      stdout: `TOPOLUMIA_PYTHON_PROBE:${JSON.stringify(result)}\n`,
      stderr: "",
    };
  };
  service = new ToolEnvironmentService({
    config,
    registry: {},
    userSettings: settings,
    applySettings: async (next) => applyUserSettings(config, next),
    commandRunner: runner,
  });
  await service.initialize();
  t.after(async () => {
    await service.catalog.close();
    await service.research.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    service,
    config,
    settings,
    root,
    prefixes,
    venv,
    calls,
    runner,
    setHold: (value) => {
      hold = value;
    },
  };
}

test("catalog discovery is lazy, distinguishes venv/uv, and does not scan all interpreters", async (t) => {
  const f = await fixture(t);
  assert.ok(
    f.service.catalog
      .view()
      .sources.every((source) => source.status === "unloaded"),
  );
  assert.equal(f.calls.length, 0);
  const discovered = await f.service.catalog.discover("conda");
  assert.equal(
    discovered.sources.find((s) => s.id === "conda").environments.length,
    3,
  );
  assert.deepEqual(
    f.calls.map((c) => c.args),
    [["info", "--json"]],
  );
  assert.ok(!JSON.stringify(discovered).includes("private-channel-secret"));
  const venvs = await f.service.catalog.discover("venv");
  const entry = venvs.sources.find((s) => s.id === "venv").environments[0];
  assert.equal(entry.manager, "uv");
  assert.equal(entry.hasPython, true);
  const registered = await f.service.catalog.register(entry.pythonCommand);
  assert.equal(registered.environment.manager, "uv");
  await f.service.catalog.discover("venv", true);
  assert.equal(
    f.service.catalog.view().sources.find((s) => s.id === "venv").environments
      .length,
    1,
  );
});

test("browsing two environments isolates results and preserves the project selection", async (t) => {
  const f = await fixture(t);
  const catalog = await f.service.catalog.discover("conda");
  const entries = catalog.sources.find((s) => s.id === "conda").environments;
  const a = entries.find((e) => e.prefix === f.prefixes[1]),
    b = entries.find((e) => e.prefix === f.prefixes[2]);
  const original = structuredClone(f.config.researchEnvironment);
  let release;
  f.setHold(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  await f.service.catalog.check(a.id);
  await f.service.catalog.check(b.id);
  const reportB = await waitFor(
    () => f.service.catalog.report(b.id),
    (r) => r.inspection.status === "completed",
  );
  assert.equal(
    reportB.inspection.components.find((c) => c.id === "wandb").version,
    "0.20.0",
  );
  assert.deepEqual(f.config.researchEnvironment, original);
  release();
  const reportA = await waitFor(
    () => f.service.catalog.report(a.id),
    (r) => r.inspection.status === "completed",
  );
  assert.equal(
    reportA.inspection.components.find((c) => c.id === "wandb").version,
    "0.18.0",
  );
  await f.service.catalog.activate(b.id);
  assert.equal(f.config.researchEnvironment.prefix, f.prefixes[2]);
  assert.equal(
    (await f.service.catalog.report(a.id)).inspection.components.find(
      (c) => c.id === "wandb",
    ).version,
    "0.18.0",
  );
  assert.equal(
    f.service.inventory().environment.find((c) => c.id === "node").version,
    process.versions.node,
  );
});

test("all-package inventories include native Conda and pip packages, support search and real pagination, and strip channels", async (t) => {
  const f = await fixture(t);
  const data = await f.service.catalog.discover("conda");
  const env = data.sources.find((s) => s.id === "conda").environments[0];
  assert.equal(
    (await f.service.catalog.packagePage(env.id)).status,
    "unchecked",
  );
  assert.ok(!f.calls.some((c) => c.args[0] === "list"));
  await f.service.catalog.refreshPackages(env.id);
  const first = await waitFor(() => f.service.catalog.packagePage(env.id));
  assert.equal(first.total, 123);
  assert.equal(first.items.length, 50);
  assert.equal(first.nextOffset, 50);
  const second = await f.service.catalog.packagePage(env.id, {
    offset: 50,
    limit: 50,
  });
  assert.equal(second.items.length, 50);
  assert.notEqual(second.items[0].name, first.items[0].name);
  const filtered = await f.service.catalog.packagePage(env.id, {
    query: "openssl",
    offset: 0,
    limit: 50,
  });
  assert.deepEqual(filtered.items, [
    { name: "openssl", version: "3.4.0", source: "conda" },
  ]);
  assert.ok(first.items.some((item) => item.source === "pip"));
  assert.ok(!JSON.stringify(first).includes("private-token"));
  assert.equal(
    f.calls.filter((c) => c.args[0] === "list").length,
    1,
    "Searching and paging must not launch Conda again",
  );
  const venv = (await f.service.catalog.discover("venv")).sources.find(
    (s) => s.id === "venv",
  ).environments[0];
  await f.service.catalog.refreshPackages(venv.id);
  const pythonPackages = await waitFor(() =>
    f.service.catalog.packagePage(venv.id),
  );
  assert.equal(pythonPackages.kind, "python-distributions");
  assert.equal(pythonPackages.total, 2);
  await assert.rejects(
    f.service.catalog.packagePage(venv.id, { offset: -1 }),
    /分页参数/,
  );
});

test("catalog and package cache survive restart; manager configuration changes retain manually registered environments", async (t) => {
  const f = await fixture(t);
  await f.service.catalog.discover("conda");
  const venv = (await f.service.catalog.discover("venv")).sources.find(
    (s) => s.id === "venv",
  ).environments[0];
  await f.service.catalog.register(venv.pythonCommand);
  await f.service.catalog.refreshPackages(venv.id);
  await waitFor(() => f.service.catalog.packagePage(venv.id));
  await f.service.catalog.close();
  const restored = new ToolEnvironmentService({
    config: f.config,
    registry: {},
    userSettings: f.settings,
    applySettings: async (next) => applyUserSettings(f.config, next),
    commandRunner: f.runner,
  });
  t.after(() => restored.catalog.close());
  const before = f.calls.length;
  await restored.initialize();
  assert.equal((await restored.catalog.packagePage(venv.id)).total, 2);
  assert.equal(f.calls.length, before);
  f.config.toolCommands.cuda = "/different/nvcc";
  restored.catalog.synchronize();
  assert.ok(
    restored.catalog
      .view()
      .sources.find((s) => s.id === "venv")
      .environments.some((e) => e.id === venv.id),
  );
});

test("Conda package inspection remains available in environments without Python", async (t) => {
  const f = await fixture(t);
  const prefix = path.join(f.root, "native only");
  await mkdir(prefix);
  f.prefixes.push(prefix);
  const catalog = await f.service.catalog.discover("conda");
  const env = catalog.sources
    .find((source) => source.id === "conda")
    .environments.find((entry) => entry.prefix === prefix);
  assert.equal(env.hasPython, false);
  await assert.rejects(f.service.catalog.check(env.id), /未安装 Python/);
  await f.service.catalog.refreshPackages(env.id);
  assert.equal(
    (await waitFor(() => f.service.catalog.packagePage(env.id))).total,
    123,
  );
});
