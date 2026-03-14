import { $ } from "bun";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { PACKAGE_NAME } from "./constants.ts";
import { getCurrentVersion, isNewer } from "./utils/version.ts";
import { pc, spinner } from "./utils/terminal.ts";
import { updateCommand } from "./commands/update.ts";
import { runCommand } from "./commands/run.ts";
import { configCommand } from "./commands/config.ts";
import { execCommand, psqlCommand, runPsqlQuery, resolveConnection } from "./commands/exec.ts";
import { syncCommand } from "./commands/sync.ts";
import { diffCommand } from "./commands/diff.ts";
import { loadConfig, ensureConfigFile, isSharedConnection, type PgdevConfig } from "./config.ts";
import { readJsonConfig } from "./utils/json.ts";
import { resolvePlaceholders, loadEnvFile } from "./utils/env.ts";

export function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/);
}

function commandError(command: string, stderr: string): string {
  if (stderr.includes("command not found")) return `not found: ${command}`;
  return `error: ${stderr || "unknown failure"}`;
}

async function getNpgsqlRestVersion(command: string): Promise<string> {
  try {
    const parts = splitCommand(command);
    const result = await $`${parts} --version --json`.quiet().nothrow();
    if (result.exitCode !== 0) return commandError(command, result.stderr.toString().trim());
    const json = JSON.parse(result.stdout.toString()) as { versions?: { NpgsqlRest?: string; NpgsqlRestClient?: string } };
    return json.versions?.NpgsqlRestClient ?? json.versions?.NpgsqlRest ?? "unknown output";
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function getPgToolVersion(command: string): Promise<string> {
  try {
    const parts = splitCommand(command);
    const result = await $`${parts} --version`.quiet().nothrow();
    if (result.exitCode !== 0) return commandError(command, result.stderr.toString().trim());
    const output = result.stdout.toString().trim();
    const match = output.match(/(\d+(?:\.\d+)+)/);
    return match?.[1] ?? "unknown output";
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function toolHint(command: string): Promise<string> {
  const cmd = command.trim();
  if (cmd.startsWith("docker ")) return "docker";
  if (cmd.startsWith("bunx ") || cmd.startsWith("npx ")) return cmd.split(" ")[0];
  if (cmd.startsWith("./") || cmd.startsWith("/") || cmd.includes("/")) return cmd;
  // Bare command — resolve via which
  const name = cmd.split(/\s+/)[0];
  try {
    const result = await $`which ${name}`.quiet().nothrow();
    if (result.exitCode === 0) return `${result.stdout.toString().trim()} (PATH)`;
  } catch {}
  return name;
}

async function getLatestNpgsqlRestRelease(): Promise<string | null> {
  try {
    const resp = await fetch("https://github.com/NpgsqlRest/NpgsqlRest/releases/latest", { redirect: "manual" });
    const location = resp.headers.get("location");
    if (!location) return null;
    // Location: https://github.com/NpgsqlRest/NpgsqlRest/releases/tag/v3.10.0
    const match = location.match(/\/tag\/v?(.+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalizeNpgsqlRestVersion(ver: string): string {
  // "3.10.0.0" → "3.10.0", "v3.10.0" → "3.10.0" (normalize to 3-part semver)
  const parts = ver.replace(/^v/, "").split(".");
  return parts.slice(0, 3).join(".");
}

function npgsqlRestUpdateHint(installed: string, latest: string | null): string {
  if (!latest) return "";
  const norm = normalizeNpgsqlRestVersion(installed);
  const normLatest = normalizeNpgsqlRestVersion(latest);
  if (norm === normLatest) return pc.dim(" (latest)");
  if (isNewer(norm, normLatest)) return pc.yellow(` (update available: ${latest})`);
  return "";
}

async function printVersion(): Promise<void> {
  const config = await loadConfig();
  const { tools } = config;

  const [npgsqlrest, psql, pgDump, pgRestore, latestNpgsqlRest] = await Promise.all([
    getNpgsqlRestVersion(tools.npgsqlrest),
    getPgToolVersion(tools.psql),
    getPgToolVersion(tools.pg_dump),
    getPgToolVersion(tools.pg_restore),
    getLatestNpgsqlRestRelease(),
  ]);

  const [hNpgsqlrest, hPsql, hPgDump, hPgRestore] = await Promise.all([
    toolHint(tools.npgsqlrest),
    toolHint(tools.psql),
    toolHint(tools.pg_dump),
    toolHint(tools.pg_restore),
  ]);

  const nrHint = !npgsqlrest.startsWith("not found:") && !npgsqlrest.startsWith("error:")
    ? npgsqlRestUpdateHint(npgsqlrest, latestNpgsqlRest)
    : "";

  const entries: [string, string, string][] = [
    [PACKAGE_NAME, getCurrentVersion(), ""],
    ["npgsqlrest", npgsqlrest, hNpgsqlrest],
    ["psql", psql, hPsql],
    ["pg_dump", pgDump, hPgDump],
    ["pg_restore", pgRestore, hPgRestore],
  ];

  const maxName = Math.max(...entries.map(([name]) => name.length));
  const maxVer = Math.max(...entries.map(([, ver]) => ver.length));

  for (const [name, ver, hint] of entries) {
    const label = name.padEnd(maxName);
    const verPad = ver.padEnd(maxVer);
    const value =
      ver.startsWith("not found:") ? pc.dim(verPad) :
      ver.startsWith("error:") ? pc.red(verPad) :
      ver.startsWith("unknown") ? pc.yellow(verPad) :
      pc.green(verPad);
    const extra = name === "npgsqlrest" ? nrHint : "";
    const suffix = hint ? `  ${pc.dim(hint)}` : "";
    console.log(`${label}  ${value}${extra}${suffix}`);
  }

  // Query server version
  const serverLabel = "server".padEnd(maxName);
  const serverResult = await runPsqlQuery(config, "SELECT version()");
  if (serverResult.ok && serverResult.rows.length > 0) {
    console.log(`${serverLabel}  ${pc.green(serverResult.rows[0])}`);
  } else if (!serverResult.ok) {
    console.log(`${serverLabel}  ${pc.dim(serverResult.error)}`);
  }
}

// --- Status command ---

interface ConfigFileInfo {
  path: string;
  optional: boolean;
  exists: boolean;
}

function extractConfigFiles(commandStr: string): { path: string; optional: boolean }[] {
  const tokens = commandStr.trim().split(/\s+/);
  const files: { path: string; optional: boolean }[] = [];
  let nextOptional = false;
  for (const token of tokens) {
    if (token === "--optional") { nextOptional = true; continue; }
    if (token.startsWith("--")) { nextOptional = false; continue; }
    if (token.endsWith(".json")) {
      files.push({ path: token, optional: nextOptional });
      nextOptional = false;
    }
  }
  return files;
}

function formatVer(ver: string, maxLen: number): string {
  const padded = ver.padEnd(maxLen);
  if (ver.startsWith("not found:")) return pc.dim(padded);
  if (ver.startsWith("error:")) return pc.red(padded);
  if (ver.startsWith("unknown")) return pc.yellow(padded);
  return pc.green(padded);
}

function printToolEntries(entries: [string, string, string, string?][]): void {
  const maxName = Math.max(...entries.map(([n]) => n.length));
  const maxVer = Math.max(...entries.map(([, v]) => v.length));
  for (const [name, ver, hint, extra] of entries) {
    const suffix = hint ? `  ${pc.dim(hint)}` : "";
    console.log(`  ${name.padEnd(maxName)}  ${formatVer(ver, maxVer)}${extra ?? ""}${suffix}`);
  }
}

async function printStatus(): Promise<void> {
  const config = await loadConfig();
  const cwd = process.cwd();

  // --- pgdev ---
  console.log(`\n${pc.bold("pgdev")}`);

  const s = spinner("Checking versions...");

  const [psql, pgDump, pgRestore, hPsql, hPgDump, hPgRestore] = await Promise.all([
    getPgToolVersion(config.tools.psql),
    getPgToolVersion(config.tools.pg_dump),
    getPgToolVersion(config.tools.pg_restore),
    toolHint(config.tools.psql),
    toolHint(config.tools.pg_dump),
    toolHint(config.tools.pg_restore),
  ]);

  s.stop();

  printToolEntries([
    [PACKAGE_NAME, getCurrentVersion(), ""],
    ["psql", psql, hPsql],
    ["pg_dump", pgDump, hPgDump],
    ["pg_restore", pgRestore, hPgRestore],
  ]);

  // Config files
  console.log();
  const tomlExists = await Bun.file(`${cwd}/pgdev.toml`).exists();
  const localTomlExists = await Bun.file(`${cwd}/pgdev.local.toml`).exists();
  console.log(`  ${tomlExists ? pc.green("✓") : pc.red("✗")} pgdev.toml${tomlExists ? "" : `  ${pc.yellow("missing")}`}`);
  console.log(`  ${localTomlExists ? pc.green("✓") : pc.dim("○")} pgdev.local.toml${localTomlExists ? "" : `  ${pc.dim("optional")}`}`);

  // Connection
  console.log();
  const connQuery = "select rolsuper, current_user, current_database(), version() from pg_roles where rolname = current_user";
  const s2 = spinner("Testing pgdev connection...");
  const connFields = await resolveConnection(config);
  if (typeof connFields === "string") {
    s2.stop();
    console.log(`  ${pc.dim("○")} ${connFields}`);
  } else {
    const serverResult = await runPsqlQuery(config, connQuery);
    s2.stop();
    const connLabel = isSharedConnection(config.connection)
      ? `shared from ${config.connection.config_file}`
      : `${connFields.host}:${connFields.port}/${connFields.database}`;
    if (serverResult.ok && serverResult.rows.length > 0) {
      const [rolsuper, user, db, version] = serverResult.rows[0].split("|");
      const superTag = rolsuper === "t" ? pc.yellow(" superuser") : "";
      console.log(`  ${pc.green("✓")} ${connLabel}  ${pc.dim(`${user}@${db}`)}${superTag}`);
      console.log(`    ${pc.dim(version)}`);
    } else if (!serverResult.ok) {
      console.log(`  ${pc.red("✗")} ${connLabel}`);
      console.log(`    ${pc.dim(serverResult.error)}`);
    }
  }

  // Project directories
  const dirs = [
    { label: "routines", path: config.project.routines_dir },
    { label: "migrations", path: config.project.migrations_dir },
    { label: "tests", path: config.project.tests_dir },
  ];
  console.log();
  for (const d of dirs) {
    if (!d.path) {
      console.log(`  ${pc.dim("○")} ${d.label}: ${pc.dim("not configured")}`);
      continue;
    }
    const fullPath = resolve(cwd, d.path);
    let isDir = false;
    try { isDir = statSync(fullPath).isDirectory(); } catch {}
    if (isDir) {
      console.log(`  ${pc.green("✓")} ${d.label}: ${d.path}`);
    } else {
      console.log(`  ${pc.yellow("○")} ${d.label}: ${d.path}  ${pc.yellow("missing")}`);
    }
  }

  // Schemas
  if (config.project.schemas.length > 0) {
    console.log();
    console.log(`  schemas: ${config.project.schemas.join(", ")}`);
  }

  // --- NpgsqlRest ---
  console.log(`\n${pc.bold("NpgsqlRest")}`);

  const s3 = spinner("Checking NpgsqlRest...");
  const [npgsqlrest, hNpgsqlrest, latestNpgsqlRest] = await Promise.all([
    getNpgsqlRestVersion(config.tools.npgsqlrest),
    toolHint(config.tools.npgsqlrest),
    getLatestNpgsqlRestRelease(),
  ]);
  s3.stop();

  const nrUpdateHint = !npgsqlrest.startsWith("not found:") && !npgsqlrest.startsWith("error:")
    ? npgsqlRestUpdateHint(npgsqlrest, latestNpgsqlRest)
    : "";
  printToolEntries([["npgsqlrest", npgsqlrest, hNpgsqlrest, nrUpdateHint]]);

  const commands = config.npgsqlrest.commands;
  const commandEntries = Object.entries(commands).filter(([, v]) => v);

  if (commandEntries.length === 0) {
    console.log(`  ${pc.dim("No commands configured")}`);
    console.log();
    return;
  }

  // Commands
  console.log();
  const maxCmd = Math.max(...commandEntries.map(([k]) => k.length));
  for (const [name, args] of commandEntries) {
    console.log(`  ${pc.cyan(name.padEnd(maxCmd))}  ${pc.dim(args)}`);
  }

  // Config files
  const seen = new Set<string>();
  const allFiles: ConfigFileInfo[] = [];
  for (const [, args] of commandEntries) {
    for (const ref of extractConfigFiles(args)) {
      if (!seen.has(ref.path)) {
        seen.add(ref.path);
        const fullPath = resolve(cwd, ref.path);
        const exists = await Bun.file(fullPath).exists();
        allFiles.push({ ...ref, exists });
      }
    }
  }

  if (allFiles.length > 0) {
    console.log();
    for (const file of allFiles) {
      const tag = file.optional ? pc.dim(" (optional)") : "";
      if (file.exists) {
        console.log(`  ${pc.green("✓")} ${file.path}${tag}`);
      } else {
        const status = file.optional ? pc.dim("missing") : pc.yellow("missing");
        console.log(`  ${pc.dim("○")} ${file.path}${tag}  ${status}`);
      }
    }
  }

  // Connections from config files
  const s4 = spinner("Testing NpgsqlRest connections...");
  const nrConnQuery = "select rolsuper, current_user, current_database(), version() from pg_roles where rolname = current_user";
  const connResults: { source: string; ok: boolean; rolsuper?: string; user?: string; db?: string; version?: string; error?: string }[] = [];

  for (const file of allFiles) {
    if (!file.exists) continue;
    const fullPath = resolve(cwd, file.path);
    const configResult = await readJsonConfig(fullPath);
    if (!configResult) continue;

    const connStrings = (configResult.data.ConnectionStrings ?? {}) as Record<string, string>;
    if (Object.keys(connStrings).length === 0) continue;

    const configSection = (configResult.data.Config ?? {}) as Record<string, unknown>;
    const envDict: Record<string, string> = {};
    if (configSection.ParseEnvironmentVariables !== false) {
      Object.assign(envDict, process.env);
      const envFile = configSection.EnvFile as string | null | undefined;
      if (envFile) {
        Object.assign(envDict, await loadEnvFile(resolve(cwd, envFile)));
      }
    }

    for (const [connName, connStr] of Object.entries(connStrings)) {
      const { resolved } = resolvePlaceholders(connStr, envDict);
      const parsed: Record<string, string> = {};
      for (const part of resolved.split(";")) {
        const eq = part.indexOf("=");
        if (eq > 0) parsed[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      }

      const fields = {
        host: parsed.Host || "localhost",
        port: parsed.Port || "5432",
        database: parsed.Database || "",
        username: parsed.Username || "",
        password: parsed.Password || "",
      };

      if (!fields.database) {
        connResults.push({ source: `${file.path} → ${connName}`, ok: false, error: "no database" });
        continue;
      }

      const psqlParts = splitCommand(config.tools.psql);
      const cmd = [...psqlParts, "-h", fields.host, "-p", fields.port, "-d", fields.database, "-U", fields.username, "-t", "-A", "-c", nrConnQuery];
      try {
        const proc = Bun.spawn(cmd, {
          stdin: "pipe", stdout: "pipe", stderr: "pipe",
          env: { ...process.env, PGPASSWORD: fields.password },
        });
        const stdout = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        if (exitCode === 0) {
          const [rolsuper, user, db, version] = stdout.trim().split("|");
          connResults.push({ source: `${file.path} → ${connName}`, ok: true, rolsuper, user, db, version });
        } else {
          const stderr = await new Response(proc.stderr).text();
          connResults.push({ source: `${file.path} → ${connName}`, ok: false, error: stderr.trim().split("\n")[0] });
        }
      } catch (err) {
        connResults.push({ source: `${file.path} → ${connName}`, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  s4.stop();

  if (connResults.length > 0) {
    console.log();
    for (const r of connResults) {
      if (r.ok) {
        const superTag = r.rolsuper === "t" ? pc.yellow(" superuser") : "";
        console.log(`  ${pc.green("✓")} ${r.source}  ${pc.dim(`${r.user}@${r.db}`)}${superTag}`);
        if (r.version) console.log(`    ${pc.dim(r.version)}`);
      } else {
        console.log(`  ${pc.red("✗")} ${r.source}`);
        if (r.error) console.log(`    ${pc.dim(r.error)}`);
      }
    }
  }

  console.log();
}

function printHelp(config?: PgdevConfig): void {
  const version = getCurrentVersion();
  let help = `
${pc.bold(PACKAGE_NAME)} ${pc.dim(`v${version}`)} - PostgreSQL and NpgsqlRest Development Toolchain

${pc.bold("Usage:")}
  ${PACKAGE_NAME} <command> [options]

${pc.bold("Commands:")}
  config          Configure tools, NpgsqlRest, environment, and project
  init, setup     Alias for config
  diff            Compare project routines with database
  exec <sql>      Execute SQL command via psql
  psql            Open interactive psql session
  sync            Sync database routines and schema to project files
    --comments          Update only comments in existing source files
    --grants            Update only grants in existing source files
    --definitions       Update only definitions in existing source files
    --all               Apply all selective updates above
  update          Update ${PACKAGE_NAME} to the latest version
`;

  const commands = config?.npgsqlrest?.commands;
  if (commands && Object.keys(commands).length > 0) {
    help += `\n${pc.bold("NpgsqlRest Commands:")}  ${pc.dim("(from pgdev.toml)")}\n`;
    const maxLen = Math.max(...Object.keys(commands).map((k) => k.length));
    for (const [name, args] of Object.entries(commands)) {
      help += `  ${name.padEnd(Math.max(maxLen, 14))}  ${pc.dim(args)}\n`;
    }
  }

  help += `
${pc.bold("Options:")}
  --version, -v   Show version number
  --status, -s    Show tools status
  --help, -h      Show this help message
`;

  console.log(help.trimStart());
}

export async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "--version" || command === "-v") {
    await printVersion();
    return;
  }

  if (command === "--status" || command === "-s") {
    await ensureConfigFile();
    await printStatus();
    return;
  }

  await ensureConfigFile();
  const config = await loadConfig();

  if (!command || command === "--help" || command === "-h") {
    printHelp(config);
    return;
  }

  switch (command) {
    case "config":
      await configCommand(config);
      break;
    case "init":
    case "setup":
      await configCommand(config);
      break;
    case "exec":
    case "execute": {
      const sql = args.slice(1).join(" ");
      if (!sql) {
        console.error(pc.red("Usage: pgdev exec <sql>"));
        process.exit(1);
      }
      await execCommand(config, sql);
      break;
    }
    case "psql":
      await psqlCommand(config);
      break;
    case "diff":
      await diffCommand(config);
      break;
    case "sync": {
      const syncFlags = {
        comments: args.includes("--comments") || args.includes("--all"),
        grants: args.includes("--grants") || args.includes("--all"),
        definitions: args.includes("--definitions") || args.includes("--all"),
      };
      await syncCommand(config, syncFlags);
      break;
    }
    case "update":
      await updateCommand(config);
      break;
    default:
      if (command === "detect") {
        console.log(pc.dim(`  "detect" has been merged into "config". Running "config" instead.\n`));
        await configCommand(config);
      } else if (config.npgsqlrest.commands[command]) {
        await runCommand(config, command, args.slice(1));
      } else {
        console.error(`Unknown command: ${pc.bold(command)}\n`);
        printHelp(config);
        process.exit(1);
      }
  }
}
