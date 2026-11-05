import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(root, "../config/topolumia.config.json");
const exampleConfigFile = path.resolve(root, "../config/topolumia.config.example.json");
function readWorkbenchConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch {
    try { return JSON.parse(fs.readFileSync(exampleConfigFile, "utf8")); } catch { return {}; }
  }
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
        target: frontendConfig.apiUrl ?? `http://${serverConfig.host ?? "127.0.0.1"}:${serverConfig.port ?? 5510}`,
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
