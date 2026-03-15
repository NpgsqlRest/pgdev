/**
 * Migration history — read/write from database comment or table.
 */

import type { PgdevConfig } from "../config.ts";
import { runPsqlQuery } from "../commands/exec.ts";
import type { HistoryEntry } from "./resolver.ts";

export type HistoryResult =
  | { ok: true; entries: HistoryEntry[] }
  | { ok: false; error: string };

/**
 * Fetch migration history from the configured storage mode.
 */
export async function fetchHistory(config: PgdevConfig): Promise<HistoryResult> {
  if (config.project.history_mode === "table") {
    return fetchHistoryFromTable(config);
  }
  return fetchHistoryFromComment(config);
}

/**
 * Fetch history from database comment.
 * The comment is JSON stored under: {"pgdev": {"<project_name>": {"migrations": [...]}}}
 */
async function fetchHistoryFromComment(config: PgdevConfig): Promise<HistoryResult> {
  const projectName = config.project.project_name;
  if (!projectName) {
    return { ok: false, error: 'project_name is required when history_mode = "comment".' };
  }

  // Get current database comment
  const sql = `SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database()`;
  const result = await runPsqlQuery(config, sql);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const comment = result.rows[0] ?? "";
  if (!comment) {
    return { ok: true, entries: [] };
  }

  try {
    const data = JSON.parse(comment);
    const pgdev = data?.pgdev;
    if (!pgdev || typeof pgdev !== "object") {
      return { ok: true, entries: [] };
    }
    const project = pgdev[projectName];
    if (!project || !Array.isArray(project.migrations)) {
      return { ok: true, entries: [] };
    }
    return { ok: true, entries: project.migrations as HistoryEntry[] };
  } catch {
    // Comment exists but isn't valid JSON — no pgdev history
    return { ok: true, entries: [] };
  }
}

/**
 * Fetch history from a dedicated table.
 */
async function fetchHistoryFromTable(config: PgdevConfig): Promise<HistoryResult> {
  const schema = config.project.history_schema || "pgdev";
  const table = config.project.history_table ||
    (config.project.project_name ? `${config.project.project_name}_history` : "migration_history");

  // Check if table exists
  const existsSql = `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name = '${table}')`;
  const existsResult = await runPsqlQuery(config, existsSql);

  if (!existsResult.ok) {
    return { ok: false, error: existsResult.error };
  }

  if (existsResult.rows[0] !== "t") {
    // Table doesn't exist yet — no history
    return { ok: true, entries: [] };
  }

  // Fetch all entries
  const sql = `SELECT name, type, version, hash FROM ${schema}.${table} ORDER BY installed_on`;
  const result = await runPsqlQuery(config, sql);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const entries: HistoryEntry[] = result.rows.map((row) => {
    const [name, type, version, hash] = row.split("|");
    return {
      name,
      type,
      version: version || undefined,
      hash,
    };
  });

  return { ok: true, entries };
}
