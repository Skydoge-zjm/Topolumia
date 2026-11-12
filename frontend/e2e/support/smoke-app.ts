import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMvpServer } from "../../../dist/src/server.js";

export const smokeCredentials = {
  username: "admin",
  password: "Topolumia-Smoke-2026!",
};

export async function startSmokeApp() {
  const root = await mkdtemp(path.join(os.tmpdir(), "topolumia-browser-smoke-"));
  const app = await startMvpServer({
    port: 0,
    testMode: false,
    collaborationFile: path.join(root, "db.sqlite"),
    userSettingsFile: path.join(root, "settings.json"),
    config: {
      project: { workspacesRoot: path.join(root, "workspaces") },
      sourceRefresh: { enabled: false },
      curator: { enabled: false },
      agentSessions: {
        profiles: [
          {
            id: "smoke-codex",
            label: "Codex",
            provider: "codex",
            driver: "codex-app-server",
            command: process.execPath,
            args: [path.resolve("dist/fixtures/native/codex-app-server.js")],
          },
        ],
      },
    },
  });
  app.collaboration.bootstrapAdmin(smokeCredentials);
  return { app, root };
}

export async function stopSmokeApp(app: { close: () => Promise<void> }, root: string) {
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
