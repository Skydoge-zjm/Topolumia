import type { SQLInputValue, StatementSync } from "node:sqlite";

/** The row projection is declared next to its SQL; values still bind through SQLite. */
export interface SqlQuery<Row extends object> {
  get(...args: SQLInputValue[]): Row | undefined;
  all(...args: SQLInputValue[]): Row[];
  iterate(...args: SQLInputValue[]): IterableIterator<Row>;
  run(...args: SQLInputValue[]): ReturnType<StatementSync["run"]>;
}
export function sqlProjection<Row extends object>(
  statement: StatementSync,
): SqlQuery<Row> {
  return statement as unknown as SqlQuery<Row>;
}
