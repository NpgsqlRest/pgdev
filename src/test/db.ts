/// <reference path="../../node_modules/bun-types/sql.d.ts" />
import { resolve } from "node:path";
import { loadEnvFile } from "../utils/env.ts";

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
  const fileVars = await loadEnvFile(envFile);

  const get = (key: string, fallback: string) =>
    fileVars[key] ?? process.env[key] ?? fallback;

  cachedConfig = {
    host: get("PGHOST", "localhost"),
    port: get("PGPORT", "5432"),
    user: get("PGUSER", "postgres"),
    password: get("PGPASSWORD", "postgres"),
    database: get("PGDATABASE", "pgdev_test"),
  };
  return cachedConfig;
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

  console.error(`[test] Recreating database "${db}"...`);

  const admin = connect("postgres");
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
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
