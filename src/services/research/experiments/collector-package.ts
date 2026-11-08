import path from "node:path";
import { readFile } from "node:fs/promises";
import { zipSync } from "fflate";
import { bundledRoot } from "../../../config.js";

export async function collectorPackage() {
  const root = path.join(bundledRoot, "scripts/runtime");
  const files = ["wandb_record_reader.py", "topolumia_collector/__init__.py", "topolumia_collector/adapters.py", "topolumia_collector/spool.py", "topolumia_collector/cli.py"];
  const contents = await Promise.all(files.map(async name => [name, new Uint8Array(await readFile(path.join(root, name)))] as const));
  return Buffer.from(zipSync(Object.fromEntries(contents), { level: 6 })).toString("base64");
}
