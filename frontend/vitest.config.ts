import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  cacheDir: path.resolve(root, "../runtime/vite-cache/vitest"),
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      "@domain": path.resolve(root, "../src/domain"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/vitest-setup.ts"],
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
  },
});
