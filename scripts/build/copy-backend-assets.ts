import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outputRoot = path.join(repositoryRoot, "dist");

async function copyTree(source, destination, filter = () => true) {
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, force: true, filter });
}

await copyTree(
  path.join(repositoryRoot, "config"), path.join(outputRoot, "config"),
  async (source) => (await stat(source)).isDirectory() || source.endsWith(".example.json"),
);
await copyTree(path.join(repositoryRoot, "src/services/agents/configuration/schemas"), path.join(outputRoot, "src/services/agents/configuration/schemas"));
await copyTree(
  path.join(repositoryRoot, "fixtures"),
  path.join(outputRoot, "fixtures"),
  (source) => !source.endsWith(".ts") && !source.endsWith(".ts.map"),
);
await copyTree(path.join(repositoryRoot, "scripts"), path.join(outputRoot, "scripts"), async (source) => (await stat(source)).isDirectory() || source.endsWith(".py") || source.endsWith(".ps1"));

await copyTree(path.join(repositoryRoot, "src/agent/skills"), path.join(outputRoot, "src/agent/skills"));
