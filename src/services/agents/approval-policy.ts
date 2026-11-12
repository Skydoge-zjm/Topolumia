import path from "node:path";
import { realpathSync } from "node:fs";
import type { AgentApproval } from "../../domain/agents/agent-approval.js";

// Resolve existing ancestors too: a newly created file may sit under a symlink.
function actualPath(file: string): string {
  try { return realpathSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(actualPath(parent), path.basename(file));
  }
}

export function approvalRisk(approval: Pick<Partial<AgentApproval>, "category" | "command" | "permissions" | "network" | "paths" | "fileChanges" | "cwd">, workspaceRoot: string): AgentApproval["risk"] {
  if (approval.category !== "file-change" || approval.command || approval.permissions || approval.network) return "elevated";
  if (!Array.isArray(approval.paths ?? []) || !Array.isArray(approval.fileChanges ?? [])) return "elevated";
  const paths = [...(approval.paths ?? []), ...(approval.fileChanges ?? []).map(change => change.path)];
  if (!paths.length) return "elevated";
  try {
    const root = actualPath(path.resolve(workspaceRoot));
    const directory = approval.cwd === undefined || approval.cwd === null ? root : path.resolve(root, approval.cwd);
    const inside = paths.every(file => {
      if (typeof file !== "string" || !file || file.includes("\0") || /[*?{}]/.test(file)) return false;
      if (process.platform !== "win32" && path.win32.isAbsolute(file) && !path.isAbsolute(file)) return false;
      const relative = path.relative(root, actualPath(path.resolve(directory, file)));
      return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
    });
    return inside ? "project-write" : "elevated";
  } catch { return "elevated"; }
}
