import path from "node:path";
import { AppError } from "../../lib/errors.js";
import { runCommand, summarizeCommandFailure } from "../../lib/command.js";

function cleanStatus(code) {
  return code?.replaceAll(".", " ") ?? "  ";
}

export function parsePorcelainV2Z(output) {
  const records = output.split(/\0|\r?\n/).filter(Boolean);
  const state = {
    oid: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith("# branch.oid ")) state.oid = record.slice(13).trim();
    else if (record.startsWith("# branch.head ")) state.head = record.slice(14).trim();
    else if (record.startsWith("# branch.upstream ")) state.upstream = record.slice(18).trim();
    else if (record.startsWith("# branch.ab ")) {
      const match = record.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        state.ahead = Number(match[1]);
        state.behind = Number(match[2]);
      }
    } else if (record.startsWith("1 ")) {
      const parts = record.split(" ");
      state.changes.push({
        kind: "ordinary",
        status: cleanStatus(parts[1]),
        path: parts.slice(8).join(" "),
      });
    } else if (record.startsWith("2 ")) {
      const parts = record.split(" ");
      state.changes.push({
        kind: "rename",
        status: cleanStatus(parts[1]),
        score: parts[8],
        path: parts.slice(9).join(" "),
        originalPath: records[index + 1] ?? null,
      });
      index += 1;
    } else if (record.startsWith("u ")) {
      const parts = record.split(" ");
      state.changes.push({
        kind: "unmerged",
        status: parts[1],
        path: parts.slice(10).join(" "),
      });
    } else if (record.startsWith("? ")) {
      state.changes.push({ kind: "untracked", status: "??", path: record.slice(2) });
    }
  }
  return state;
}

export function parseNumstat(output, staged) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [added, deleted, ...pathParts] = line.split("\t");
    return {
      path: pathParts.join("\t"),
      added: added === "-" ? null : Number(added),
      deleted: deleted === "-" ? null : Number(deleted),
      binary: added === "-" || deleted === "-",
      staged,
    };
  });
}

export class GitAdapter {
  constructor(config) {
    this.config = config;
    this.id = "git-local";
  }

  async command(args, options = {}) {
    return runCommand(this.config.git.command, args, {
      cwd: this.config.project.root,
      timeoutMs: this.config.git.timeoutMs,
      maxOutputBytes: this.config.git.maxOutputBytes,
      ...options,
    });
  }

  async health() {
    const checkedAt = new Date().toISOString();
    const [version, inside] = await Promise.all([
      this.command(["--version"]),
      this.command(["rev-parse", "--is-inside-work-tree"]),
    ]);
    if (!version.ok || !inside.ok || inside.stdout.trim() !== "true") {
      return {
        status: "unavailable",
        detail: summarizeCommandFailure(!inside.ok ? inside : version),
        checkedAt,
      };
    }
    return { status: "ready", detail: version.stdout.trim(), checkedAt };
  }

  async descriptor() {
    return {
      id: this.id,
      kind: "source",
      provider: "git",
      label: "local Git",
      mode: "live",
      capabilities: ["health", "snapshot", "diff-summary"],
      health: await this.health(),
    };
  }

  async snapshot() {
    const observedAt = new Date().toISOString();
    const [rootResult, statusResult, logResult, unstagedResult, stagedResult] = await Promise.all([
      this.command(["rev-parse", "--show-toplevel"]),
      this.command(["status", "--porcelain=v2", "--branch", "-z"]),
      this.command(["log", "-1", "--format=%H%x00%h%x00%aI%x00%s"]),
      this.command(["diff", "--no-ext-diff", "--numstat"]),
      this.command(["diff", "--cached", "--no-ext-diff", "--numstat"]),
    ]);

    const failed = [rootResult, statusResult, logResult, unstagedResult, stagedResult].find((result) => !result.ok);
    if (failed) {
      throw new AppError("GIT_SNAPSHOT_FAILED", "无法读取 local Git 状态。", {
        status: 503,
        detail: { reason: summarizeCommandFailure(failed) },
        retryable: failed.timedOut,
      });
    }

    const status = parsePorcelainV2Z(statusResult.stdout);
    const [sha, shortSha, authoredAt, ...subjectParts] = logResult.stdout.replace(/\r?\n$/, "").split("\0");
    const subject = subjectParts.join("\0");
    const repoRoot = path.resolve(rootResult.stdout.trim());
    const ref = `git:commit:${sha}`;

    return {
      ref,
      source: this.id,
      kind: "codeSnapshot",
      externalId: sha,
      version: sha,
      label: `${status.head ?? "detached"} @ ${shortSha}`,
      locator: `git://${repoRoot.replaceAll("\\", "/")}#${sha}`,
      observedAt,
      repoRoot,
      head: { sha, shortSha, authoredAt, subject },
      branch: {
        name: status.head,
        upstream: status.upstream,
        ahead: status.ahead,
        behind: status.behind,
      },
      changes: status.changes,
      diffSummary: [
        ...parseNumstat(unstagedResult.stdout, false),
        ...parseNumstat(stagedResult.stdout, true),
      ],
      dirty: status.changes.length > 0,
    };
  }
}
