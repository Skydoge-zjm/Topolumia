import path from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = fileURLToPath(new URL("../../../runtime/", import.meta.url));

/** Keep generated artifacts in the repository runtime directory for any working directory. */
export function runtimeArtifact(...segments: string[]) {
  return path.join(runtimeRoot, ...segments);
}
