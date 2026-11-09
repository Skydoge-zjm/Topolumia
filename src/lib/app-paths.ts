import os from "node:os";
import path from "node:path";

/** Installation files and user-owned state have separate lifecycles. */
export function appPaths({
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const root = paths.join(home, ".topolumia");
  return {
    root,
    dataRoot: paths.join(root, "data"),
    configRoot: root,
    cacheRoot: paths.join(root, "cache"),
    workspacesRoot: paths.join(root, "workspaces"),
    configFile: paths.join(root, "topolumia.config.json"),
  };
}

export function configurationFiles(env = process.env) {
  return env.TOPOLUMIA_CONFIG
    ? [path.resolve(env.TOPOLUMIA_CONFIG)]
    : [appPaths().configFile];
}
