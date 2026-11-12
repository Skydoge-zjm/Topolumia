import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Savepoints also compose inside a business mutation's outer transaction. */
export function sqliteTransaction<T>(db: Pick<DatabaseSync, "exec">, operation: () => T): T {
  const name = `research_${randomUUID().replaceAll("-", "")}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}
