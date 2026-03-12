/// <reference path="../../node_modules/bun-types/sql.d.ts" />
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadEnvFile, resolvePlaceholders } from "../utils/env.ts";

/** Database names that must NEVER be dropped. */
const PROTECTED_DATABASES = new Set(["postgres", "template0", "template1"]);

export interface TestConfig {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

let cachedConfig: TestConfig | null = null;

export async function loadTestConfig(): Promise<TestConfig> {
  if (cachedConfig) return cachedConfig;

  const envFile = resolve(import.meta.dir, "../../test.env");

  // Hard fail if test.env is missing — never guess database config
  if (!existsSync(envFile)) {
    throw new Error(
      `test.env not found at ${envFile}. ` +
      `Create it with PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE pointing to a test database. ` +
      `This file is required to prevent accidentally dropping a production database.`
    );
  }

  const fileVars = await loadEnvFile(envFile);

  // Require PGDATABASE to be explicitly set — never use a default
  if (!fileVars.PGDATABASE) {
    throw new Error(
      `PGDATABASE is not set in test.env. ` +
      `Explicitly set the test database name to prevent accidental drops.`
    );
  }

  // Replace {placeholders} — e.g. {test_suffix} gets a random string
  const { resolved: database } = resolvePlaceholders(fileVars.PGDATABASE, {
    test_suffix: Math.random().toString(36).slice(2, 10),
  });

  // Only use test.env for config — never fall through to process.env
  // to prevent accidentally dropping a real database (e.g. from .env)
  cachedConfig = {
    host: fileVars.PGHOST ?? "localhost",
    port: fileVars.PGPORT ?? "5432",
    user: fileVars.PGUSER ?? "postgres",
    password: fileVars.PGPASSWORD ?? "postgres",
    database,
  };

  return cachedConfig;
}

/**
 * Validate that a database name is safe to drop.
 * Throws if the name matches a protected database or doesn't contain "test".
 */
function assertSafeToDropDatabase(name: string): void {
  if (PROTECTED_DATABASES.has(name.toLowerCase())) {
    throw new Error(`FATAL: refusing to drop protected database "${name}"`);
  }
  if (!name.toLowerCase().includes("test")) {
    throw new Error(
      `FATAL: refusing to drop database "${name}" — name does not contain "test". ` +
      `This safeguard prevents accidental drops of production databases. ` +
      `If this is a test database, include "test" in the name (e.g. "${name}_test").`
    );
  }
}

function connect(database?: string) {
  const cfg = cachedConfig!;
  return new Bun.SQL({
    hostname: cfg.host,
    port: Number(cfg.port),
    username: cfg.user,
    password: cfg.password,
    database: database ?? cfg.database,
  });
}

export async function createTestDb(): Promise<void> {
  const cfg = await loadTestConfig();
  const db = cfg.database;

  assertSafeToDropDatabase(db);

  const admin = connect("postgres");
  try {
    // Drop any leftover test databases from previous runs (random suffixes accumulate)
    const leftover = await admin.unsafe(
      `SELECT datname FROM pg_database WHERE datname LIKE 'pgdev_test_%'`
    );
    for (const row of leftover) {
      const name = (row as Record<string, string>).datname;
      assertSafeToDropDatabase(name);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }

    console.error(`[test] Creating database "${db}"...`);
    await admin.unsafe(`CREATE DATABASE "${db}"`);
  } finally {
    await admin.close();
  }
}

export async function runSetupScript(): Promise<void> {
  await loadTestConfig();
  const setupPath = resolve(import.meta.dir, "setup.sql");
  const setupSql = await Bun.file(setupPath).text();

  const conn = connect();
  try {
    await conn.unsafe(setupSql);
  } finally {
    await conn.close();
  }
}

export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  await loadTestConfig();
  const conn = connect();
  try {
    const rows = await conn.unsafe(sql);
    return [...rows] as T[];
  } finally {
    await conn.close();
  }
}
