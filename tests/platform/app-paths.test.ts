import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { appPaths, configurationFiles } from "../../src/lib/app-paths.js";
import { loadConfig, mvpRoot } from "../../src/config.js";
import { isPathInside } from "../../src/adapters/sources/filesystem-adapter.js";

test("all platforms use the home .topolumia root for configuration, data, cache and workspaces", () => {
  for (const [platform, home] of [
    ["win32", "C:\\Users\\Scientist"],
    ["darwin", "/Users/scientist"],
    ["linux", "/home/scientist"],
  ] as const) {
    const paths = platform === "win32" ? path.win32 : path.posix;
    const locations = appPaths({ platform, home });
    const root = paths.join(home, ".topolumia");
    assert.deepEqual(locations, {
      root,
      dataRoot: paths.join(root, "data"),
      configRoot: root,
      cacheRoot: paths.join(root, "cache"),
      workspacesRoot: paths.join(root, "workspaces"),
      configFile: paths.join(root, "topolumia.config.json"),
    });
  }
});

test("frontend and backend share one user configuration file and honor an explicit override", () => {
  const explicit = configurationFiles({
    TOPOLUMIA_CONFIG: "custom/config.json",
  });
  assert.equal(explicit.length, 1);
  assert.equal(explicit[0], path.resolve("custom/config.json"));
  assert.deepEqual(configurationFiles({}), [appPaths().configFile]);
});

test("default workspaces and application directories are outside the repository; configured data files remain explicit", async () => {
  const config = await loadConfig();
  assert.equal(
    config.collaboration.databaseFile,
    path.join(appPaths().dataRoot, "collaboration.sqlite"),
  );
  assert.equal(
    config.userSettings.file,
    path.join(appPaths().dataRoot, "user-settings.json"),
  );
  assert.equal(isPathInside(mvpRoot, config.project.workspacesRoot), false);
  assert.equal(isPathInside(mvpRoot, config.applicationPaths.dataRoot), false);
  assert.equal(
    isPathInside(mvpRoot, config.applicationPaths.configRoot),
    false,
  );
  const explicit = await loadConfig({
    collaboration: { databaseFile: "runtime/preserved.sqlite" },
  });
  assert.ok(explicit.collaboration.databaseFile.endsWith("preserved.sqlite"));
  assert.equal(explicit.project.workspacesRoot, config.project.workspacesRoot);
});
