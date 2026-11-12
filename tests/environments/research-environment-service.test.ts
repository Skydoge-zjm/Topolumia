import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ResearchEnvironmentService } from "../../src/services/environments/research-environment-service.js";

test("research environment selection verifies the interpreter and records component metadata", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "topolumia-research-selection-"),
  );
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const config: any = {
    project: { root },
    researchEnvironment: {
      kind: "default",
      prefix: "",
      pythonCommand: "python",
    },
    toolCommands: { conda: "conda", cuda: "nvcc" },
    tensorboard: { pythonCommand: "python" },
  };
  const settings: any = {
    filePath: path.join(root, "settings.json"),
    update: async (patch: any) => {
      settings.settings = { ...(settings.settings ?? {}), ...patch };
      return { settings: settings.settings };
    },
  };
  const calls: string[] = [];
  const commandRunner = async (command: string, args: string[]) => {
    calls.push(args.at(-1) ?? "");
    const mode = args.at(-1);
    const python = {
      executable: process.execPath,
      version: "3.12.8",
      prefix: root,
      basePrefix: root,
      kind: "venv",
    };
    const payload =
      mode === "identity"
        ? { status: "ready", python }
        : mode === "packages"
          ? {
              status: "ready",
              python,
              packages: {
                jupyterlab: "4.0.0",
                tensorboard: null,
                wandb: "0.18.0",
                            torch: "2.5.0",
                jax: null,
                tensorflow: null,
              },
              executables: { nvcc: null },
            }
          : {
              status: mode === "torch" ? "ready" : "not_installed",
              version: mode === "torch" ? "2.5.0" : null,
              gpuAvailable: false,
              gpuTest: "unavailable",
            };
    return {
      ok: true,
      stdout: `TOPOLUMIA_PYTHON_PROBE:${JSON.stringify(payload)}\n`,
      stderr: "",
      timedOut: false,
    };
  };
  const service = new ResearchEnvironmentService({
    config,
    settings,
    applySettings: async (next: any) => Object.assign(config, next),
    commandRunner,
  });
  await service.select({ kind: "custom", pythonCommand: process.execPath });
  await service.pending;
  const view = service.view();
  assert.deepEqual(view.selection, {
    kind: "custom",
    prefix: "",
    pythonCommand: process.execPath,
  });
  assert.equal(view.status, "completed");
  assert.equal(
    view.components.find((item) => item.id === "python")?.version,
    "3.12.8",
  );
  assert.equal(
    view.components.find((item) => item.id === "wandb")?.status,
    "installed",
  );
  assert.equal(
    view.components.find((item) => item.id === "torch")?.status,
    "ready",
  );
  assert.ok(calls.includes("packages"));
  const restored = new ResearchEnvironmentService({
    config,
    settings,
    applySettings: async () => {},
    commandRunner,
  });
  const beforeRestore = calls.length;
  await restored.initialize();
  assert.equal(
    restored.view().components.find((item) => item.id === "wandb")?.version,
    "0.18.0",
  );
  assert.equal(
    calls.length,
    beforeRestore,
    "Reading cached diagnostics must not launch package imports",
  );
});

test("research environment selection rejects an invalid Conda prefix before changing settings", async () => {
  const config: any = {
    project: { root: process.cwd() },
    researchEnvironment: {
      kind: "default",
      prefix: "",
      pythonCommand: "python",
    },
    toolCommands: { conda: process.execPath },
  };
  const settings: any = {
    filePath: path.join(os.tmpdir(), "topolumia-settings.json"),
    update: async () => {
      throw new Error("must not update");
    },
  };
  const service = new ResearchEnvironmentService({
    config,
    settings,
    applySettings: async () => {},
    commandRunner: async (_command: string, args: string[]) => {
      if (args[0] === "info")
        return {
          ok: true,
          stdout: JSON.stringify({ root_prefix: process.cwd(), envs: [] }),
          stderr: "",
        };
      return { ok: false, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(
    service.select({
      kind: "conda",
      prefix: path.join(process.cwd(), "missing"),
    }),
    /不存在或未安装 Python/,
  );
});
