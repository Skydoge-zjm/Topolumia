import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  rename,
  cp,
  rm,
  readdir,
  access,
} from "node:fs/promises";
import { constants } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import * as z from "zod/v4";
import { AppError } from "../../lib/errors.js";
import { ProjectDataStore, projectDataPaths } from "./project-data-store.js";

const manifestSchema = z.strictObject({
  schemaVersion: z.literal("topolumia-project.v1"),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{1,100}$/),
  name: z.string().min(1).max(160),
});
export type ProjectManifest = z.infer<typeof manifestSchema>;
type Project = { id: string; name: string; root: string };
const missing = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  ["ENOENT", "ENOTDIR"].includes(String(error.code));
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';

export async function readProjectManifest(
  root: string,
): Promise<ProjectManifest | null> {
  const paths = projectDataPaths(root);
  const directory = await lstat(paths.directory).catch((error) => {
    if (missing(error)) return null;
    throw new AppError(
      "PROJECT_DATA_UNAVAILABLE",
      "项目数据目录不可访问，请检查目录位置和权限。",
      { status: 409, cause: error },
    );
  });
  if (!directory) return null;
  try {
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("Invalid project data directory");
    const info = await lstat(paths.manifest);
    const database = await lstat(paths.database);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 16384 ||
      !database.isFile() ||
      database.isSymbolicLink()
    )
      throw new Error("Incomplete project data");
    return manifestSchema.parse(
      JSON.parse(await readFile(paths.manifest, "utf8")),
    );
  } catch (cause) {
    throw new AppError(
      "PROJECT_DATA_INVALID",
      "该目录的 .topolumia 项目数据不完整或不可用，原内容不会被覆盖。",
      { status: 422, cause },
    );
  }
}

/** Copy database files through SQLite backup so committed WAL contents travel with the project. */
async function copyData(source: string, destination: string) {
  const info = await lstat(source).catch((error) => {
    if (missing(error)) return null;
    throw error;
  });
  if (!info) return;
  if (info.isSymbolicLink())
    throw new AppError(
      "PROJECT_DATA_LINK_INVALID",
      "项目数据中包含符号链接，请先整理为完整的普通文件。",
      { status: 422 },
    );
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(source)) {
      if (/(?:-wal|-shm)$/.test(entry)) continue;
      await copyData(path.join(source, entry), path.join(destination, entry));
    }
  } else if (/\.(?:sqlite|db)$/.test(source)) {
    await mkdir(path.dirname(destination), { recursive: true });
    const database = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(database, destination);
    } finally {
      database.close();
    }
  } else if (info.isFile()) {
    await cp(source, destination, { errorOnExist: true, force: false });
  } else
    throw new AppError(
      "PROJECT_DATA_INVALID",
      "项目数据包含无法备份的文件类型。",
      { status: 422 },
    );
}

async function publishDirectory(
  project: Project,
  populate: (directory: string) => Promise<void>,
) {
  await access(project.root, constants.W_OK);
  const target = projectDataPaths(project.root).directory;
  const staging = path.join(project.root, ".topolumia-prepare-" + randomUUID());
  await mkdir(staging, { mode: 0o700 });
  try {
    await writeFile(path.join(staging, ".gitignore"), "*\n", {
      flag: "wx",
      mode: 0o600,
    });
    await populate(staging);
    const db = new ProjectDataStore(
      path.join(staging, "research.sqlite"),
      project.id,
      { create: true },
    );
    try {
      const result = db.db.prepare("PRAGMA integrity_check").get();
      if (result?.integrity_check !== "ok")
        throw new Error("Project database integrity check failed");
    } finally {
      db.close();
    }
    await writeFile(
      path.join(staging, "project.json"),
      JSON.stringify(
        {
          schemaVersion: "topolumia-project.v1",
          id: project.id,
          name: project.name,
        } satisfies ProjectManifest,
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    // An existing directory is never replaced, including a concurrently created project.
    if (
      await lstat(target).catch((error) => {
        if (missing(error)) return null;
        throw error;
      })
    )
      throw new AppError(
        "PROJECT_DATA_EXISTS",
        "目标目录已有 .topolumia，不能覆盖现有项目数据。",
        { status: 409 },
      );
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function initializeProjectData(
  project: Project,
  seed?: (directory: string) => Promise<void>,
) {
  const existing = await readProjectManifest(project.root);
  if (existing) {
    if (existing.id !== project.id)
      throw new AppError(
        "PROJECT_DATA_MISMATCH",
        "该目录属于另一个 Topolumia 项目。",
        { status: 409 },
      );
    const checked = new ProjectDataStore(
      projectDataPaths(project.root).database,
      project.id,
    );
    checked.close();
    return;
  }
  await publishDirectory(project, seed ?? (async () => {}));
}

/** One complete preserved copy changes storage ownership; original application data stays intact. */
export async function preserveProjectData(
  project: Project,
  directory: string,
  accountDb: DatabaseSync,
  settingsFile: string,
  historyDirectory: string,
) {
  const database = new DatabaseSync(path.join(directory, "research.sqlite"));
  try {
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    database.exec(
      "CREATE TABLE project_snapshots(project_id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0,state_json TEXT NOT NULL,state_hash TEXT,updated_at TEXT NOT NULL)",
    );
    const tables = accountDb
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND (name LIKE 'research_%' OR name LIKE 'record_%' OR name IN ('project_snapshots','project_record_sources')) AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const table of tables) {
        const name = String(table.name);
        const columns = accountDb
          .prepare(`PRAGMA table_info(${quote(name)})`)
          .all()
          .map((column) => String(column.name));
        const partition = columns.includes("project_id")
          ? "project_id"
          : columns.includes("project")
            ? "project"
            : null;
        if (!partition) throw new Error("Unscoped scientific table: " + name);
        if (name !== "project_snapshots") database.exec(String(table.sql));
        const rows = accountDb.prepare(
          `SELECT * FROM ${quote(name)} WHERE ${quote(partition)}=?`,
        );
        const insert = database.prepare(
          `INSERT INTO ${quote(name)}(${columns.map(quote).join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
        );
        let count = 0;
        for (const row of rows.iterate(project.id)) {
          insert.run(...columns.map((column) => row[column]));
          count++;
        }
        if (
          Number(
            database
              .prepare(`SELECT count(*) AS count FROM ${quote(name)}`)
              .get()?.count,
          ) !== count
        )
          throw new Error("Incomplete project copy: " + name);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
  for (const name of [
    "research-assets",
    "agent-config",
    "ssh-projects",
    "curator",
    "agent-skills",
  ])
    await copyData(
      path.join(path.dirname(settingsFile), name),
      path.join(directory, name),
    );
  await copyData(settingsFile, path.join(directory, "settings.json"));
  await copyData(historyDirectory, path.join(directory, "agent-sessions"));
  await copyData(
    path.join(project.root, ".topolumia-transfer"),
    path.join(directory, "transfers"),
  );
}

export async function relocateProjectData(
  project: Project,
  destination: string,
) {
  if (path.resolve(project.root) === path.resolve(destination)) return;
  const existing = await readProjectManifest(destination);
  const original = await readProjectManifest(project.root);
  if (existing) {
    if (existing.id !== project.id)
      throw new AppError(
        "PROJECT_DATA_MISMATCH",
        "目标目录属于另一个 Topolumia 项目。",
        { status: 409 },
      );
    if (original)
      throw new AppError(
        "PROJECT_DATA_EXISTS",
        "新旧位置都已有项目数据，请选择未包含 .topolumia 的目录，避免覆盖任一副本。",
        { status: 409 },
      );
    return;
  }
  if (!original || original.id !== project.id)
    throw new AppError(
      "PROJECT_DATA_UNAVAILABLE",
      "找不到原项目数据，请选择包含完整 .topolumia 的项目目录。",
      { status: 409 },
    );
  await publishDirectory(
    { ...project, root: destination },
    async (directory) => {
      for (const name of await readdir(
        projectDataPaths(project.root).directory,
      )) {
        if (
          name === "project.json" ||
          name === ".gitignore" ||
          /(?:-wal|-shm)$/.test(name)
        )
          continue;
        await copyData(
          path.join(projectDataPaths(project.root).directory, name),
          path.join(directory, name),
        );
      }
    },
  );
}
