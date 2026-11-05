import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(file)));
    else if (entry.isFile() && entry.name.endsWith(".test.js"))
      files.push(file);
  }
  return files.sort();
}
const files = await collect(path.join(root, "dist", "tests"));
if (!files.length)
  throw new Error(
    "No compiled backend tests found; run npm run build:backend first.",
  );
const child = spawn(
  process.execPath,
  ["--test", "--test-concurrency=4", ...process.argv.slice(2), ...files],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
child.once("error", (error) => {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
