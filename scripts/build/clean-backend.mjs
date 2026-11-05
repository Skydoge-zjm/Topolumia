import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.resolve(root, "dist");
if (path.dirname(output) !== root || path.basename(output) !== "dist") throw new Error("Invalid generated output directory");
await rm(output, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
