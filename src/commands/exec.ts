import { resolve } from "node:path";
import { type PgdevConfig, isSharedConnection } from "../config.ts";
import { error, pc, formatCmd } from "../utils/terminal.ts";
import { splitCommand } from "../cli.ts";
import { resolveEnvVars, loadEnvFile, buildPgdevEnvDict } from "../utils/env.ts";
import { readJsonConfig } from "../utils/json.ts";

export interface ConnectionFields {
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

export async function resolveConnection(config: PgdevConfig): Promise<ConnectionFields | string> {
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

export type PsqlResult = { ok: true; rows: string[]; cmd: string } | { ok: false; error: string; cmd: string };

export async function runPsqlQuery(config: PgdevConfig, sql: string): Promise<PsqlResult> {
  const fields = await resolveConnection(config);
  if (typeof fields === "string") return { ok: false, error: fields, cmd: "" };
  if (!fields.database) return { ok: false, error: "No database specified in connection.", cmd: "" };

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

  const cmdStr = formatCmd(cmd);

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
      return { ok: false, error: stderr.trim() || "psql exited with code " + exitCode, cmd: cmdStr };
    }
    const rows = stdout.trim().split("\n").filter(Boolean);
    return { ok: true, rows, cmd: cmdStr };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), cmd: cmdStr };
  }
}

export type PsqlCsvResult = { ok: true; rows: Record<string, string>[]; cmd: string } | { ok: false; error: string; cmd: string };

export async function runPsqlCsvQuery(config: PgdevConfig, sql: string): Promise<PsqlCsvResult> {
  const fields = await resolveConnection(config);
  if (typeof fields === "string") return { ok: false, error: fields, cmd: "" };
  if (!fields.database) return { ok: false, error: "No database specified in connection.", cmd: "" };

  const psqlParts = splitCommand(config.tools.psql);
  const cmd = [
    ...psqlParts,
    "-h", fields.host,
    "-p", fields.port,
    "-d", fields.database,
    "-U", fields.username,
    "--csv",
    "-c", sql,
  ];

  const cmdStr = formatCmd(cmd);

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
      return { ok: false, error: stderr.trim() || "psql exited with code " + exitCode, cmd: cmdStr };
    }
    const rows = parseCsvOutput(stdout.trim());
    return { ok: true, rows, cmd: cmdStr };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), cmd: cmdStr };
  }
}

/** Parse psql --csv output into array of records. Handles quoted fields with commas/newlines. */
function parseCsvOutput(output: string): Record<string, string>[] {
  if (!output) return [];

  const lines = parseCsvLines(output);
  if (lines.length < 2) return [];

  const headers = lines[0];
  return lines.slice(1).map((fields) => {
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = fields[i] ?? "";
    }
    return row;
  });
}

/** Split CSV text into rows of fields, handling quoted fields with embedded newlines/commas. */
function parseCsvLines(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;

  while (i < text.length) {
    const { fields, nextPos } = parseCsvRow(text, i);
    rows.push(fields);
    i = nextPos;
  }

  return rows;
}

function parseCsvRow(text: string, start: number): { fields: string[]; nextPos: number } {
  const fields: string[] = [];
  let i = start;

  while (i <= text.length) {
    if (i === text.length || text[i] === "\n") {
      fields.push("");
      i++;
      break;
    }

    if (text[i] === '"') {
      // Quoted field
      let value = "";
      i++; // skip opening quote
      while (i < text.length) {
        if (text[i] === '"') {
          if (i + 1 < text.length && text[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          value += text[i];
          i++;
        }
      }
      fields.push(value);
    } else {
      // Unquoted field
      let value = "";
      while (i < text.length && text[i] !== "," && text[i] !== "\n") {
        value += text[i];
        i++;
      }
      fields.push(value);
    }

    if (i < text.length && text[i] === ",") {
      i++; // skip comma
      continue;
    }
    if (i < text.length && text[i] === "\n") {
      i++; // skip newline
    }
    break;
  }

  return { fields, nextPos: i };
}

export async function execCommand(config: PgdevConfig, sql: string): Promise<void> {
  const { cmd, env } = await buildPsqlArgs(config);
  cmd.push("-c", sql);

  if (config.verbose) {
    console.error(pc.cyan(formatCmd(cmd)));
  }

  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", env });
  const exitCode = await proc.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

export async function psqlCommand(config: PgdevConfig): Promise<void> {
  const { cmd, env } = await buildPsqlArgs(config);

  if (config.verbose) {
    console.error(pc.cyan(formatCmd(cmd)));
  }

  const proc = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
  const exitCode = await proc.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
