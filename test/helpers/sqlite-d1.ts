import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import type { D1Like, D1Statement } from "../../src/types.ts";

class Statement implements D1Statement {
  private readonly db: DatabaseSync;
  readonly sql: string;
  readonly values: unknown[];

  constructor(db: DatabaseSync, sql: string, values: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: unknown[]): D1Statement {
    return new Statement(this.db, this.sql, values);
  }
  async run(): Promise<unknown> {
    return this.db.prepare(this.sql).run(...(this.values as never[]));
  }
  async first<T = unknown>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...(this.values as never[])) as T | undefined) ?? null;
  }
  async all<T = unknown>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.values as never[])) as T[] };
  }
}

/** An in-memory SQLite database with the real migrations applied, shaped like D1. */
export function createTestDb(): D1Like & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) {
    raw.exec(readFileSync(new URL(file, dir), "utf8"));
  }

  return {
    raw,
    prepare: (sql: string) => new Statement(raw, sql),
    async batch(statements: D1Statement[]) {
      raw.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        raw.exec("COMMIT");
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
