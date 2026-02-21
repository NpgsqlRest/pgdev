import { resolve } from "node:path";
import { type PgdevConfig, isSharedConnection } from "../config.ts";
import { error, pc, formatCmd } from "../utils/terminal.ts";
import { splitCommand } from "../cli.ts";
import { resolveEnvVars, loadEnvFile, buildPgdevEnvDict } from "../utils/env.ts";
import { readJsonConfig } from "../utils/json.ts";

interface ConnectionFields {
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
}

function parseConnectionString(connStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of connStr.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    result[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return result;
}

async function resolveConnection(config: PgdevConfig): Promise<ConnectionFields | string> {
  if (isSharedConnection(config.connection)) {
    const configFile = config.connection.config_file;
    if (!configFile) return "No config file set in connection.";

    const fullPath = resolve(process.cwd(), configFile);
    const configResult = await readJsonConfig(fullPath);
    if (!configResult) return `Failed to read ${configFile}`;

    const connStrings = (configResult.data.ConnectionStrings ?? {}) as Record<string, string>;
    const connKeys = Object.keys(connStrings);
    if (connKeys.length === 0) return `No connection strings in ${configFile}`;

    const npgsqlRestSection = (configResult.data.NpgsqlRest ?? {}) as Record<string, unknown>;
    const connName = config.connection.connection_name
      ?? (npgsqlRestSection.ConnectionName as string | null)
      ?? connKeys[0];

    const connStr = connStrings[connName];
    if (!connStr) return `Connection "${connName}" not found in ${configFile}`;

    const configSection = (configResult.data.Config ?? {}) as Record<string, unknown>;
    const envDict: Record<string, string> = {};
    if (configSection.ParseEnvironmentVariables !== false) {
      Object.assign(envDict, process.env);
      const envFile = configSection.EnvFile as string | null | undefined;
      if (envFile) {
        Object.assign(envDict, await loadEnvFile(resolve(process.cwd(), envFile)));
      }
    }
    const { resolved } = resolveEnvVars(connStr, envDict);
    const parsed = parseConnectionString(resolved);

    return {
      host: parsed.Host || "localhost",
      port: parsed.Port || "5432",
      database: parsed.Database || "",
      username: parsed.Username || "",
      password: parsed.Password || "",
    };
  }

  const conn = config.connection;
  if (!conn.database && !conn.host) {
    return "No connection configured. Run pgdev init or pgdev config to set up.";
  }

  const envDict = await buildPgdevEnvDict(config.env_file);
  const resolve_ = (v: string) => resolveEnvVars(v, envDict).resolved;

  return {
    host: resolve_(conn.host ?? "") || "localhost",
    port: resolve_(conn.port ?? "") || "5432",
    database: resolve_(conn.database ?? ""),
    username: resolve_(conn.username ?? ""),
    password: resolve_(conn.password ?? ""),
  };
}

async function buildPsqlArgs(config: PgdevConfig): Promise<{ cmd: string[]; env: Record<string, string | undefined> }> {
  const fields = await resolveConnection(config);
  if (typeof fields === "string") {
    console.error(error(fields));
    process.exit(1);
  }

  if (!fields.database) {
    console.error(error("No database specified in connection."));
    process.exit(1);
  }

  const psqlParts = splitCommand(config.tools.psql);
  const cmd = [
    ...psqlParts,
    "-h", fields.host,
    "-p", fields.port,
    "-d", fields.database,
    "-U", fields.username,
  ];

  return { cmd, env: { ...process.env, PGPASSWORD: fields.password } };
}

export async function runPsqlQuery(config: PgdevConfig, sql: string): Promise<{ ok: true; rows: string[] } | { ok: false; error: string }> {
  const fields = await resolveConnection(config);
  if (typeof fields === "string") return { ok: false, error: fields };
  if (!fields.database) return { ok: false, error: "No database specified in connection." };

  const psqlParts = splitCommand(config.tools.psql);
  const cmd = [
    ...psqlParts,
    "-h", fields.host,
    "-p", fields.port,
    "-d", fields.database,
    "-U", fields.username,
    "-t", "-A",
    "-c", sql,
  ];

  try {
    const proc = Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PGPASSWORD: fields.password },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return { ok: false, error: stderr.trim() || "psql exited with code " + exitCode };
    }
    const rows = stdout.trim().split("\n").filter(Boolean);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function execCommand(config: PgdevConfig, sql: string): Promise<void> {
  const { cmd, env } = await buildPsqlArgs(config);
  cmd.push("-c", sql);

  if (config.verbose) {
    console.error(pc.dim(formatCmd(cmd)));
  }

  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", env });
  const exitCode = await proc.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

export async function psqlCommand(config: PgdevConfig): Promise<void> {
  const { cmd, env } = await buildPsqlArgs(config);

  if (config.verbose) {
    console.error(pc.dim(formatCmd(cmd)));
  }

  const proc = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
  const exitCode = await proc.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
