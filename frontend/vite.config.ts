import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { configurationFiles } from "../src/lib/app-paths";

const root = path.dirname(fileURLToPath(import.meta.url));
function readWorkbenchConfig() {
  const config: {
    server: { host?: string; port?: number };
    frontend: { host?: string; port?: number; apiUrl?: string };
  } = { server: {}, frontend: {} };
  for (const file of configurationFiles()) {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      Object.assign(config.server, value.server);
      Object.assign(config.frontend, value.frontend);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return config;
}
const workbenchConfig = readWorkbenchConfig();
const frontendConfig = workbenchConfig.frontend ?? {};
const serverConfig = workbenchConfig.server ?? {};

export default defineConfig(({ mode }) => ({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      "@domain": path.resolve(root, "../src/domain"),
    },
  },
  server: {
    host: frontendConfig.host ?? "127.0.0.1",
    port: Number(frontendConfig.port ?? 5610),
    strictPort: false,
    proxy: {
      "/api": {
        target:
          frontendConfig.apiUrl ??
          `http://${serverConfig.host ?? "127.0.0.1"}:${serverConfig.port ?? 5510}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: mode !== "production",
    chunkSizeWarningLimit: 1600,
  },
}));
