import { $ } from "bun";
import { statSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { loadConfig, type PgdevConfig, updateConfig, updateConfigBool, updateConfigArraySync, removeConfigKey, isSharedConnection } from "../config.ts";
import { success, error, pc, formatCmd, spinner } from "../utils/terminal.ts";
import { ask, askConfirm, askValue, askPath, askDashboard, askMultiSelect } from "../utils/prompt.ts";
import { readJsonConfig, writeJsonConfig } from "../utils/json.ts";
import { splitCommand } from "../cli.ts";
import { resolveEnvVars, loadEnvFile, buildPgdevEnvDict } from "../utils/env.ts";
import { runPsqlQuery } from "./exec.ts";
import { setupNpgsqlRest, setupPostgresTools } from "./setup.ts";
import { detectNpgsqlRest, detectPgTools, type PgInstallation } from "../utils/tools.ts";

// --- Tool status helpers ---

function toolStatus(value: string, defaultValue: string): string {
  if (!value) return "not configured";
  return value === defaultValue ? `default (${value})` : value;
}

function toolsStatus(config: PgdevConfig): string {
  return `npgsqlrest: ${toolStatus(config.tools.npgsqlrest, "npgsqlrest")}, psql: ${toolStatus(config.tools.psql, "psql")}`;
}

function configFilesStatus(config: PgdevConfig): string {
  const commands = Object.values(config.npgsqlrest.commands);
  if (commands.length === 0) return "not initialized";
  const files = new Set<string>();
  for (const cmd of commands) {
    for (const token of cmd.trim().split(/\s+/)) {
      if (token.endsWith(".json") && !token.startsWith("--")) {
        files.add(token.split("/").pop()!);
      }
    }
  }
  if (files.size === 0) return "not initialized";
  return `${files.size} file${files.size > 1 ? "s" : ""} (${[...files].join(", ")})`;
}

// --- Tool handlers ---

async function savePgTools(chosen: PgInstallation): Promise<string> {
  const psqlCmd = chosen.binDir ? `${chosen.binDir}/psql` : "psql";
  const pgDumpCmd = chosen.binDir ? `${chosen.binDir}/pg_dump` : "pg_dump";
  const pgRestoreCmd = chosen.binDir ? `${chosen.binDir}/pg_restore` : "pg_restore";

  await updateConfig("tools", "psql", psqlCmd);
  await updateConfig("tools", "pg_dump", pgDumpCmd);
  await updateConfig("tools", "pg_restore", pgRestoreCmd);

  return `tools.psql = "${psqlCmd}"\ntools.pg_dump = "${pgDumpCmd}"\ntools.pg_restore = "${pgRestoreCmd}"`;
}

async function handleNpgsqlRest(): Promise<string | undefined> {
  const s = spinner("Detecting NpgsqlRest installation...");
  const result = await detectNpgsqlRest(false);

  if (result) {
    s.stop(success(`Found NpgsqlRest v${result.version}`));
    console.log(pc.dim(`  Source: ${result.source}`));

    const choice = await ask("Use this installation?", [
      { label: `Use ${result.command}`, description: `v${result.version}` },
      { label: "Set up differently", description: "Install via npm, bun, binary, or docker" },
      { label: "Skip", description: "Don't configure NpgsqlRest now" },
    ]);

    if (choice === 0) {
      await updateConfig("tools", "npgsqlrest", result.command);
      return `tools.npgsqlrest = "${result.command}"`;
    } else if (choice === 1) {
      await setupNpgsqlRest();
    }
  } else {
    s.stop(error("No NpgsqlRest installation found"));

    const choice = await ask("What would you like to do?", [
      { label: "Install now", description: "Set up NpgsqlRest" },
      { label: "Skip", description: "Configure later" },
    ]);

    if (choice === 0) {
      await setupNpgsqlRest();
    }
  }
  return undefined;
}

async function handlePgTools(): Promise<string | undefined> {
  const s = spinner("Detecting PostgreSQL client tools...");
  const pgInstalls = await detectPgTools(false);

  if (pgInstalls.length === 0) {
    s.stop(error("No PostgreSQL client tools found"));

    const choice = await ask("What would you like to do?", [
      { label: "Install now", description: "Set up PostgreSQL client tools" },
      { label: "Skip", description: "Configure later" },
    ]);

    if (choice === 0) {
      await setupPostgresTools();
    }
    return undefined;
  } else if (pgInstalls.length === 1) {
    const chosen = pgInstalls[0];
    s.stop(success(`Found PostgreSQL client tools v${chosen.version}`));
    console.log(pc.dim(`  Source: ${chosen.source}`));

    const choice = await ask("Use this installation?", [
      { label: "Use detected", description: `v${chosen.version} (${chosen.source})` },
      { label: "Set up differently", description: "Install via package manager" },
      { label: "Skip", description: "Don't configure PostgreSQL tools now" },
    ]);

    if (choice === 0) {
      return await savePgTools(chosen);
    } else if (choice === 1) {
      await setupPostgresTools();
    }
  } else {
    s.stop(success(`Found ${pgInstalls.length} PostgreSQL installations`));

    const options = pgInstalls.map((p) => ({
      label: `v${p.version}`,
      description: p.binDir ? `${p.source} (${p.binDir})` : p.source,
    }));
    options.push({ label: "Set up differently", description: "Install via package manager" });
    options.push({ label: "Skip", description: "Don't configure PostgreSQL tools now" });

    const choice = await ask("Which installation should pgdev use?", options);

    if (choice >= 0 && choice < pgInstalls.length) {
      return await savePgTools(pgInstalls[choice]);
    } else if (choice === pgInstalls.length) {
      await setupPostgresTools();
    }
  }
  return undefined;
}

// --- Tools Setup dashboard ---

async function editToolsSetup(config: PgdevConfig): Promise<void> {
  let currentConfig = config;
  let lastSelected: string | undefined;
  let lastStatus: string | undefined;

  while (true) {
    const sections = [
      {
        title: "",
        items: [
          {
            key: "npgsqlrest",
            label: "NpgsqlRest",
            value: toolStatus(currentConfig.tools.npgsqlrest, "npgsqlrest"),
            help: "REST API server for PostgreSQL functions and procedures.\nSelect to detect installation or install.",
          },
          {
            key: "pgtools",
            label: "PostgreSQL tools",
            value: toolStatus(currentConfig.tools.psql, "psql"),
            help: "psql, pg_dump, pg_restore — PostgreSQL client tools.\nSelect to detect installation or install.",
          },
          {
            key: "configfiles",
            label: "NpgsqlRest Config Files",
            value: configFilesStatus(currentConfig),
            help: "Setup NpgsqlRest JSON config files (production, development, local).\nSelect to create or change config file paths.",
          },
        ],
      },
    ];
    const actions = [
      { key: "d", label: "Detect all tools" },
      { key: "q", label: "Back" },
    ];

    const choice = await askDashboard("Tools Setup", sections, actions, { selected: lastSelected, status: lastStatus });
    lastStatus = undefined;

    if (choice === null || (choice.type === "action" && choice.key === "q")) break;

    if (choice.type === "action" && choice.key === "d") {
      const nStatus = await handleNpgsqlRest();
      const pStatus = await handlePgTools();
      lastStatus = [nStatus, pStatus].filter(Boolean).join("\n") || undefined;
      currentConfig = await loadConfig();
      lastSelected = undefined;
      continue;
    }

    if (choice.type === "item") {
      lastSelected = choice.key;
      if (choice.key === "npgsqlrest") {
        lastStatus = await handleNpgsqlRest();
      } else if (choice.key === "pgtools") {
        lastStatus = await handlePgTools();
      } else if (choice.key === "configfiles") {
        await handleConfigFiles(currentConfig);
      }
      currentConfig = await loadConfig();
    }
  }
}

// --- NpgsqlRest config file initialization ---

function configHeader(description: string): string {
  return `//
// ${description}
//
// NpgsqlRest Configuration
// Reference: https://npgsqlrest.github.io/config/
// Default values: https://npgsqlrest.github.io/config/latest.html
// Guide: https://npgsqlrest.github.io/guide/configuration.html
//
`;
}

const CONFIG_FILES = {
  appsettings: {
    file: "appsettings.json",
    description: "Server configuration",
  },
  development: {
    file: "development.json",
    description: "Development overrides (e.g. logging, debug settings)",
  },
  production: {
    file: "production.json",
    description: "Base configuration for all environments",
  },
  local: {
    file: "local.json",
    description: "Personal overrides, not committed to git",
  },
} as const;



function parseCommandFiles(config: PgdevConfig): { production: string; development: string; local: string } {
  const devCmd = config.npgsqlrest.commands.dev || "";
  if (!devCmd) return { production: "", development: "", local: "" };
  const files = extractConfigFiles(devCmd);
  const prod = files.find((f) => !f.optional)?.path ?? "";
  const optionals = files.filter((f) => f.optional);
  return { production: prod, development: optionals[0]?.path ?? "", local: optionals[1]?.path ?? "" };
}

type ConfigRole = "production" | "development" | "local";

const CONFIG_ROLE_META: Record<ConfigRole, { label: string; defaultPath: string; description: string; help: string; gitignore: boolean }> = {
  production: { label: "Production", defaultPath: "./config/production.json", description: CONFIG_FILES.production.description, help: "Base configuration for all environments.", gitignore: false },
  development: { label: "Development", defaultPath: "./config/development.json", description: CONFIG_FILES.development.description, help: "Development overrides (optional, layered on production).", gitignore: false },
  local: { label: "Local", defaultPath: "./config/local.json", description: CONFIG_FILES.local.description, help: "Personal overrides, not committed to git (optional).", gitignore: true },
};

const CONFIG_ROLE_ORDER: ConfigRole[] = ["production", "development", "local"];

async function saveConfigCommands(files: { production: string; development: string; local: string }): Promise<void> {
  if (!files.production) {
    // Clear all commands
    for (const name of ["dev", "serve", "validate", "validate-prod"]) {
      await updateConfig("npgsqlrest.commands", name, "");
    }
    return;
  }

  let dev = files.production;
  if (files.development) dev += ` --optional ${files.development}`;
  if (files.local) dev += ` --optional ${files.local}`;

  await updateConfig("npgsqlrest.commands", "dev", dev);
  await updateConfig("npgsqlrest.commands", "serve", files.production);
  await updateConfig("npgsqlrest.commands", "validate", dev + " --validate");
  await updateConfig("npgsqlrest.commands", "validate-prod", files.production + " --validate");
}

async function ensureConfigFile(filePath: string, role: ConfigRole): Promise<string> {
  const meta = CONFIG_ROLE_META[role];
  const dir = dirname(filePath);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });

  const msgs: string[] = [];
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    await Bun.write(filePath, configHeader(meta.description) + "{}\n");
    msgs.push(`Created ${filePath}`);
  }
  if (meta.gitignore) {
    const gitignorePath = `${process.cwd()}/.gitignore`;
    const gitignoreFile = Bun.file(gitignorePath);
    let content = (await gitignoreFile.exists()) ? await gitignoreFile.text() : "";
    if (!content.split("\n").some((line) => line.trim() === filePath)) {
      const suffix = content.endsWith("\n") || content === "" ? "" : "\n";
      await Bun.write(gitignorePath, content + suffix + filePath + "\n");
      msgs.push(`Added ${filePath} to .gitignore`);
    }
  }
  return msgs.length > 0 ? msgs.join("\n") : `Updated ${filePath}`;
}

async function handleConfigFiles(config: PgdevConfig): Promise<void> {
  let currentConfig = config;
  let lastSelected: string | undefined;
  let lastStatus: string | undefined;

  while (true) {
    const files = parseCommandFiles(currentConfig);

    const items: { key: string; label: string; value: string; help?: string }[] = [];
    for (const role of CONFIG_ROLE_ORDER) {
      if (files[role]) {
        items.push({ key: role, label: CONFIG_ROLE_META[role].label, value: files[role], help: CONFIG_ROLE_META[role].help });
      }
    }

    // Determine next addable role
    const nextRole = CONFIG_ROLE_ORDER.find((r) => !files[r]);
    if (nextRole) {
      items.push({ key: "+new", label: "+ Add new", value: "", help: `Add ${CONFIG_ROLE_META[nextRole].label.toLowerCase()} config file.` });
    }

    const sections = [{ title: "", items }];
    const actions = [{ key: "q", label: "Back" }];

    const choice = await askDashboard("NpgsqlRest Config Files", sections, actions, { selected: lastSelected, status: lastStatus });
    lastStatus = undefined;
    if (choice === null || (choice.type === "action" && choice.key === "q")) break;

    if (choice.type === "item") {
      lastSelected = choice.key;

      if (choice.key === "+new" && nextRole) {
        const meta = CONFIG_ROLE_META[nextRole];
        const filePath = askValue(meta.label, meta.defaultPath, { path: true });
        if (filePath) {
          lastStatus = await ensureConfigFile(filePath, nextRole);
          const updated = { ...files, [nextRole]: filePath };
          await saveConfigCommands(updated);
        }
      } else if (choice.key in CONFIG_ROLE_META) {
        const role = choice.key as ConfigRole;
        const editChoice = await ask(`${CONFIG_ROLE_META[role].label} config`, [
          { label: "Change path", description: `Currently: ${files[role]}` },
          ...(role !== "production" ? [{ label: "Remove", description: "Remove this config file reference" }] : []),
        ], { exit: true });

        if (editChoice === 0) {
          const newPath = askValue(CONFIG_ROLE_META[role].label, files[role], { path: true });
          if (newPath && newPath !== files[role]) {
            lastStatus = await ensureConfigFile(newPath, role);
            const updated = { ...files, [role]: newPath };
            await saveConfigCommands(updated);
          }
        } else if (editChoice === 1 && role !== "production") {
          const updated = { ...files, [role]: "" };
          await saveConfigCommands(updated);
          lastStatus = `Removed ${files[role]}`;
        }
      }
      currentConfig = await loadConfig();
    }
  }
}

// --- Types ---

interface ConfigFileRef {
  path: string;
  optional: boolean;
}

interface ParsedConnectionString {
  [key: string]: string;
}

// --- Config file discovery ---

function extractConfigFiles(commandStr: string): ConfigFileRef[] {
  const tokens = commandStr.trim().split(/\s+/);
  const files: ConfigFileRef[] = [];
  let nextOptional = false;

  for (const token of tokens) {
    if (token === "--optional") {
      nextOptional = true;
      continue;
    }
    if (token.startsWith("--")) {
      nextOptional = false;
      continue;
    }
    if (token.endsWith(".json")) {
      files.push({ path: token, optional: nextOptional });
      nextOptional = false;
    }
  }
  return files;
}

function discoverConfigFiles(config: PgdevConfig): ConfigFileRef[] {
  const seen = new Set<string>();
  const files: ConfigFileRef[] = [];

  for (const commandStr of Object.values(config.npgsqlrest.commands)) {
    for (const ref of extractConfigFiles(commandStr)) {
      if (!seen.has(ref.path)) {
        seen.add(ref.path);
        files.push(ref);
      }
    }
  }
  return files;
}

// --- Connection string utilities ---

const CONN_FIELD_ORDER = ["Host", "Port", "Database", "Username", "Password"];

interface ConnParamDef {
  name: string;
  category: string;
  type: "string" | "boolean" | "integer" | "enum";
  enumValues?: string[];
  default: string;
  help: string;
}

const CONN_PARAMS: ConnParamDef[] = [
  // Basic
  { name: "Host", category: "Basic", type: "string", default: "localhost", help: "PostgreSQL server hostname or IP address. Multiple hosts for failover: host1,host2." },
  { name: "Port", category: "Basic", type: "integer", default: "5432", help: "TCP port of the PostgreSQL server." },
  { name: "Database", category: "Basic", type: "string", default: "", help: "PostgreSQL database name. Defaults to Username if not set." },
  { name: "Username", category: "Basic", type: "string", default: "", help: "Username for authentication." },
  { name: "Password", category: "Basic", type: "string", default: "", help: "Password for authentication." },
  { name: "Passfile", category: "Basic", type: "string", default: "", help: "Path to a pgpass file for password lookup." },
  // Security
  { name: "SSL Mode", category: "Security", type: "enum", enumValues: ["Disable", "Allow", "Prefer", "Require"], default: "Prefer", help: "Controls whether SSL/TLS is used for the connection." },
  { name: "Trust Server Certificate", category: "Security", type: "boolean", default: "false", help: "Whether to trust the server certificate without validation." },
  { name: "SSL Certificate", category: "Security", type: "string", default: "", help: "Path to client SSL certificate file." },
  { name: "SSL Key", category: "Security", type: "string", default: "", help: "Path to client SSL key file." },
  { name: "SSL Password", category: "Security", type: "string", default: "", help: "Password for the SSL client key." },
  { name: "Root Certificate", category: "Security", type: "string", default: "", help: "Path to SSL root (CA) certificate file." },
  { name: "Check Certificate Revocation", category: "Security", type: "boolean", default: "false", help: "Whether to check certificate revocation status." },
  { name: "SSL Negotiation", category: "Security", type: "string", default: "", help: "Controls SSL negotiation mode." },
  { name: "GSS Encryption Mode", category: "Security", type: "enum", enumValues: ["Disable", "Prefer", "Require"], default: "Prefer", help: "Controls whether GSS encryption is used." },
  { name: "Channel Binding", category: "Security", type: "enum", enumValues: ["Disable", "Prefer", "Require"], default: "Prefer", help: "Controls channel binding for SCRAM authentication." },
  { name: "Include Realm", category: "Security", type: "boolean", default: "false", help: "Include realm information in Kerberos authentication." },
  { name: "Kerberos Service Name", category: "Security", type: "string", default: "postgres", help: "Kerberos service name for GSSAPI authentication." },
  { name: "Include Error Detail", category: "Security", type: "boolean", default: "false", help: "Include error detail from server in exceptions." },
  { name: "Persist Security Info", category: "Security", type: "boolean", default: "false", help: "Whether to include password in the connection string returned by the connection." },
  { name: "Log Parameters", category: "Security", type: "boolean", default: "false", help: "Log parameters of executed SQL statements." },
  // Pooling
  { name: "Pooling", category: "Pooling", type: "boolean", default: "true", help: "Whether connection pooling is enabled." },
  { name: "Minimum Pool Size", category: "Pooling", type: "integer", default: "0", help: "Minimum number of connections in the pool." },
  { name: "Maximum Pool Size", category: "Pooling", type: "integer", default: "100", help: "Maximum number of connections in the pool." },
  { name: "Connection Idle Lifetime", category: "Pooling", type: "integer", default: "300", help: "Seconds a connection can be idle before being pruned." },
  { name: "Connection Pruning Interval", category: "Pooling", type: "integer", default: "10", help: "Seconds between pool pruning sweeps." },
  { name: "Connection Lifetime", category: "Pooling", type: "integer", default: "3600", help: "Maximum seconds a connection can live (0 = unlimited)." },
  // Timeouts
  { name: "Timeout", category: "Timeouts", type: "integer", default: "15", help: "Seconds to wait for a connection to open." },
  { name: "Command Timeout", category: "Timeouts", type: "integer", default: "30", help: "Seconds to wait for a command to complete (0 = indefinite)." },
  { name: "Cancellation Timeout", category: "Timeouts", type: "integer", default: "2000", help: "Milliseconds to wait for query cancellation." },
  { name: "Keepalive", category: "Timeouts", type: "integer", default: "0", help: "Seconds between TCP keepalive packets (0 = disabled)." },
  { name: "Tcp Keepalive", category: "Timeouts", type: "boolean", default: "false", help: "Whether to use TCP keepalive." },
  { name: "Tcp Keepalive Time", category: "Timeouts", type: "integer", default: "0", help: "Seconds of idle before sending TCP keepalive (0 = system default)." },
  { name: "Tcp Keepalive Interval", category: "Timeouts", type: "integer", default: "0", help: "Seconds between TCP keepalive retransmissions." },
  // Performance
  { name: "No Reset On Close", category: "Performance", type: "boolean", default: "false", help: "Skip DISCARD ALL when returning connection to pool." },
  { name: "Read Buffer Size", category: "Performance", type: "integer", default: "8192", help: "Size of the read buffer in bytes." },
  { name: "Write Buffer Size", category: "Performance", type: "integer", default: "8192", help: "Size of the write buffer in bytes." },
  { name: "Socket Receive Buffer Size", category: "Performance", type: "integer", default: "0", help: "TCP socket receive buffer size (0 = OS default)." },
  { name: "Socket Send Buffer Size", category: "Performance", type: "integer", default: "0", help: "TCP socket send buffer size (0 = OS default)." },
  { name: "Max Auto Prepare", category: "Performance", type: "integer", default: "0", help: "Max number of auto-prepared statements (0 = disabled)." },
  { name: "Auto Prepare Min Usages", category: "Performance", type: "integer", default: "5", help: "Minimum usages before a statement is auto-prepared." },
  // Failover
  { name: "Target Session Attributes", category: "Failover", type: "enum", enumValues: ["Any", "Primary", "PreferPrimary", "PreferStandby", "Standby", "ReadWrite", "ReadOnly"], default: "Any", help: "Determines which server to connect to in multi-host setups." },
  { name: "Load Balance Hosts", category: "Failover", type: "boolean", default: "false", help: "Whether to load balance across multiple hosts." },
  { name: "Host Recheck Seconds", category: "Failover", type: "integer", default: "10", help: "Seconds before rechecking host state in failover." },
  // Misc
  { name: "Application Name", category: "Misc", type: "string", default: "", help: "Application name sent to PostgreSQL." },
  { name: "Search Path", category: "Misc", type: "string", default: "", help: "Sets the schema search path." },
  { name: "Client Encoding", category: "Misc", type: "string", default: "UTF8", help: "Client-side encoding." },
  { name: "Timezone", category: "Misc", type: "string", default: "", help: "Session timezone." },
  { name: "Options", category: "Misc", type: "string", default: "", help: "Command-line options sent to the server at connection start." },
  { name: "Enlist", category: "Misc", type: "boolean", default: "true", help: "Whether to enlist in ambient TransactionScope." },
  { name: "Multiplexing", category: "Misc", type: "boolean", default: "false", help: "Enable connection multiplexing." },
  { name: "Array Nullability Mode", category: "Misc", type: "enum", enumValues: ["Never", "Always", "PerInstance"], default: "Never", help: "Controls nullability of array elements." },
];

const CONN_PARAM_ORDER = CONN_PARAMS.map((p) => p.name);

function getConnParamDef(name: string): ConnParamDef | undefined {
  return CONN_PARAMS.find((p) => p.name === name);
}

function parseConnectionString(connStr: string): ParsedConnectionString {
  const result: ParsedConnectionString = {};
  for (const part of connStr.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    result[key] = value;
  }
  return result;
}

function serializeConnectionString(parsed: ParsedConnectionString): string {
  const parts: string[] = [];
  const added = new Set<string>();
  // Catalog order first
  for (const key of CONN_PARAM_ORDER) {
    if (key in parsed) {
      parts.push(`${key}=${parsed[key]}`);
      added.add(key);
    }
  }
  // Then any remaining keys not in catalog
  for (const [key, value] of Object.entries(parsed)) {
    if (!added.has(key)) {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(";");
}

function maskConnectionString(connStr: string): string {
  return connStr.replace(/(Password\s*=\s*)([^;]*)/i, "$1****");
}

// --- NpgsqlRest validate ---

interface ValidateResult {
  valid: boolean;
  configValid: boolean;
  warnings: string[];
  connectionTest: string;
}

async function validateNpgsqlRest(
  config: PgdevConfig,
  filePath: string,
): Promise<{ result: ValidateResult; cmd: string[] } | { error: string; cmd: string[] }> {
  const toolCmd = splitCommand(config.tools.npgsqlrest);
  const cmd = [...toolCmd, filePath, "--validate", "--json"];

  try {
    const proc = Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    try {
      const json = JSON.parse(stdout) as ValidateResult;
      return { result: json, cmd };
    } catch {
      return { error: stdout.trim() || "No output from npgsqlrest --validate", cmd };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), cmd };
  }
}

function formatValidateResult(
  output: { result: ValidateResult; cmd: string[] } | { error: string; cmd: string[] },
  verbose: boolean,
): string {
  const lines: string[] = [];

  if (verbose) {
    lines.push(pc.cyan(formatCmd(output.cmd)));
  }

  if ("error" in output) {
    lines.push(error(`Validate failed: ${output.error}`));
    return lines.join("\n");
  }

  const r = output.result;

  if (r.configValid) {
    lines.push(success("Config: OK"));
  } else {
    lines.push(error(`Config: ${r.warnings.length} unknown key(s)`));
    for (const w of r.warnings) {
      lines.push(pc.yellow(`  ${w}`));
    }
  }

  if (r.connectionTest === "ok") {
    lines.push(success("Connection: OK"));
  } else {
    lines.push(error(`Connection: ${r.connectionTest}`));
  }

  return lines.join("\n");
}

// --- Config schema ---

interface SchemaProperty {
  type?: string | string[];
  default?: unknown;
  enum?: string[];
  description?: string;
}

async function fetchConfigSchema(config: PgdevConfig): Promise<Record<string, unknown> | null> {
  try {
    const cmd = [...splitCommand(config.tools.npgsqlrest), "--config-schema"];
    const result = await $`${cmd}`.quiet().nothrow();
    if (result.exitCode !== 0) return null;
    return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getSchemaSection(schema: Record<string, unknown> | null, section: string): Record<string, SchemaProperty> {
  if (!schema) return {};
  const props = (schema as Record<string, Record<string, Record<string, unknown>>>).properties;
  if (!props?.[section]?.properties) return {};
  return props[section].properties as unknown as Record<string, SchemaProperty>;
}

function isSchemaBoolean(prop: SchemaProperty): boolean {
  return prop.type === "boolean" || (Array.isArray(prop.type) && prop.type.includes("boolean"));
}

function isSchemaNumber(prop: SchemaProperty): boolean {
  const types = Array.isArray(prop.type) ? prop.type : [prop.type];
  return types.includes("integer") || types.includes("number");
}

function isNullable(prop: SchemaProperty): boolean {
  return Array.isArray(prop.type) && prop.type.includes("null");
}

function getSchemaTopLevel(schema: Record<string, unknown> | null): Record<string, SchemaProperty> {
  if (!schema) return {};
  const props = (schema as Record<string, Record<string, unknown>>).properties;
  if (!props) return {};
  const result: Record<string, SchemaProperty> = {};
  for (const [key, value] of Object.entries(props)) {
    const prop = value as SchemaProperty;
    // Skip object sections (Config, ConnectionStrings, etc.) — only keep scalar top-level settings
    if (prop.type === "object" || (Array.isArray(prop.type) && prop.type.includes("object"))) continue;
    result[key] = prop;
  }
  return result;
}

function getSchemaObjectSections(schema: Record<string, unknown> | null): Record<string, SchemaProperty> {
  if (!schema) return {};
  const props = (schema as Record<string, Record<string, unknown>>).properties;
  if (!props) return {};
  const result: Record<string, SchemaProperty> = {};
  for (const [key, value] of Object.entries(props)) {
    const prop = value as SchemaProperty;
    // Skip Config and ConnectionStrings — they have dedicated editors
    if (key === "Config" || key === "ConnectionStrings") continue;
    const types = Array.isArray(prop.type) ? prop.type : [prop.type ?? ""];
    if (types.includes("object")) {
      result[key] = prop;
    }
  }
  return result;
}

function extractDescriptions(schema: Record<string, unknown> | null): Record<string, string> {
  if (!schema) return {};
  const result: Record<string, string> = {};
  function walk(props: Record<string, unknown>, prefix: string) {
    for (const [key, value] of Object.entries(props)) {
      const prop = value as Record<string, unknown>;
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof prop.description === "string") {
        result[path] = prop.description;
      }
      if (prop.properties && typeof prop.properties === "object") {
        walk(prop.properties as Record<string, unknown>, path);
      }
    }
  }
  const props = (schema as Record<string, Record<string, unknown>>).properties;
  if (props) walk(props, "");
  return result;
}

// --- Schema property classification ---

type PropertyClass = "boolean" | "enum" | "string" | "number" | "object" | "array-scalar" | "array-object" | "dictionary";

function classifyProperty(prop: SchemaProperty): PropertyClass {
  if (prop.enum) return "enum";
  if (isSchemaBoolean(prop)) return "boolean";
  if (isSchemaNumber(prop)) return "number";
  const types = Array.isArray(prop.type) ? prop.type : [prop.type ?? "string"];
  if (types.includes("array")) {
    const items = (prop as Record<string, unknown>).items as Record<string, unknown> | undefined;
    return items?.type === "object" || items?.properties ? "array-object" : "array-scalar";
  }
  if (types.includes("object")) {
    const p = prop as Record<string, unknown>;
    const hasProps = p.properties && typeof p.properties === "object" && Object.keys(p.properties as object).length > 0;
    const hasAdditional = p.additionalProperties;
    if (hasAdditional && !hasProps) return "dictionary";
    return "object";
  }
  return "string";
}

function getNestedProperties(prop: SchemaProperty): Record<string, SchemaProperty> | null {
  const p = (prop as Record<string, unknown>).properties;
  return p && typeof p === "object" ? p as Record<string, SchemaProperty> : null;
}

function formatPropertyValue(value: unknown, prop: SchemaProperty): string {
  if (value === undefined || value === null) {
    const def = prop.default;
    if (def === undefined || def === null) return "(not set)";
    return `${def} (default)`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.length <= 3) return `[${value.map(String).join(", ")}]`;
    return `[${value.length} items]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return "{}";
    return `{${keys.length} key${keys.length > 1 ? "s" : ""}}`;
  }
  return String(value);
}

function formatSectionStatus(value: unknown): string {
  if (value === undefined || value === null) return "(defaults)";
  if (typeof value !== "object") return String(value);
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) return "(defaults)";
  return `${keys.length} key${keys.length > 1 ? "s" : ""} configured`;
}

function coerceArrayItem(value: string, prop: SchemaProperty): unknown {
  const items = (prop as Record<string, unknown>).items as Record<string, unknown> | undefined;
  const itemType = items?.type;
  if (itemType === "integer") return Math.round(Number(value)) || 0;
  if (itemType === "number") return Number(value) || 0;
  return value;
}

// --- Connection testing ---

interface ConnectionFields {
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
}

function resolveConnectionField(value: string, envDict: Record<string, string>, warnings: string[]): string {
  const { resolved, unresolved } = resolveEnvVars(value, envDict);
  if (unresolved.length > 0) {
    warnings.push(`Unresolved: ${unresolved.join(", ")}`);
  }
  return resolved;
}

async function testConnectionFields(
  config: PgdevConfig,
  fields: ConnectionFields,
): Promise<{ success: boolean; version?: string; error?: string; cmd: string[] }> {
  const psqlParts = splitCommand(config.tools.psql);
  const cmd = [...psqlParts];
  if (fields.host) { cmd.push("-h", fields.host); }
  if (fields.port) { cmd.push("-p", fields.port); }
  if (fields.database) { cmd.push("-d", fields.database); }
  if (fields.username) { cmd.push("-U", fields.username); }
  cmd.push("-t", "-A", "-c", "SELECT version()");

  try {
    const proc = Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PGPASSWORD: fields.password },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode === 0) return { success: true, version: stdout.trim(), cmd };
    const stderr = await new Response(proc.stderr).text();
    return { success: false, error: stderr.trim(), cmd };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), cmd };
  }
}


// --- Editing: Top Level Config ---

// --- NpgsqlRest dashboard helpers ---

async function editSchemaItem(
  container: Record<string, unknown>,
  name: string,
  prop: SchemaProperty,
): Promise<boolean> {
  if (prop.enum) {
    const enumChoice = await ask(name, prop.enum.map((v) => ({
      label: v,
      description: v === String(prop.default) ? "(default)" : "",
    })));
    if (enumChoice === -1) return false;
    container[name] = prop.enum[enumChoice];
  } else if (isSchemaBoolean(prop)) {
    const current = container[name] ?? prop.default;
    container[name] = !current;
  } else if (isSchemaNumber(prop)) {
    const current = container[name] ?? prop.default;
    const value = askValue(name, current === null || current === undefined ? "" : String(current));
    if (value === null) return false;
    if (!value) {
      if (isNullable(prop)) container[name] = null;
      else delete container[name];
    } else {
      const num = Number(value);
      if (!isNaN(num)) {
        const isInt = prop.type === "integer" || (Array.isArray(prop.type) && prop.type.includes("integer"));
        container[name] = isInt ? Math.round(num) : num;
      }
    }
  } else {
    const current = (container[name] as string) ?? "";
    const isPath = /file|path|dir/i.test(name);
    const value = askValue(name, current, isPath ? { path: true } : undefined);
    if (value === null) return false;
    if (value) {
      container[name] = value;
    } else {
      delete container[name];
    }
  }
  return true;
}

// --- Generic section editors ---

async function editArrayProperty(
  container: Record<string, unknown>,
  name: string,
  prop: SchemaProperty,
): Promise<boolean> {
  let arr = Array.isArray(container[name]) ? [...(container[name] as unknown[])] : [];
  let dirty = false;
  let lastSelected: string | undefined;

  while (true) {
    const items = arr.map((v, i) => ({
      key: `item.${i}`,
      label: String(v),
      value: "",
    }));
    items.push({ key: "+add", label: "+ Add", value: "" });

    const sections = [{ title: "", items }];
    const actions: { key: string; label: string }[] = [];
    if (arr.length > 0) actions.push({ key: "c", label: "Clear all" });
    actions.push({ key: "q", label: "Back" });

    const choice = await askDashboard(name, sections, actions, { selected: lastSelected });

    if (choice === null || (choice.type === "action" && choice.key === "q")) {
      if (dirty) container[name] = arr;
      return dirty;
    }

    if (choice.type === "action" && choice.key === "c") {
      arr = [];
      dirty = true;
      continue;
    }

    if (choice.type === "item") {
      lastSelected = choice.key;
      if (choice.key === "+add") {
        const value = askValue("Value", "");
        if (value !== null && value !== "") {
          arr.push(coerceArrayItem(value, prop));
          dirty = true;
        }
      } else if (choice.key.startsWith("item.")) {
        const idx = parseInt(choice.key.slice(5), 10);
        const action = await ask(String(arr[idx]), [
          { label: "Edit", description: "Change this value" },
          { label: "Remove", description: "Delete from list" },
        ]);
        if (action === 0) {
          const value = askValue("Value", String(arr[idx]));
          if (value !== null) {
            if (value) {
              arr[idx] = coerceArrayItem(value, prop);
            } else {
              arr.splice(idx, 1);
              lastSelected = undefined;
            }
            dirty = true;
          }
        } else if (action === 1) {
          arr.splice(idx, 1);
          dirty = true;
          lastSelected = undefined;
        }
      }
    }
  }
}

async function editDictionaryProperty(
  container: Record<string, unknown>,
  name: string,
  prop: SchemaProperty,
  descriptions: Record<string, string>,
  parentPath: string,
): Promise<boolean> {
  const dict = (container[name] ?? {}) as Record<string, unknown>;
  container[name] = dict;
  let dirty = false;
  let lastSelected: string | undefined;

  const additionalProps = (prop as Record<string, unknown>).additionalProperties as Record<string, unknown> | undefined;
  const isObjectValues = additionalProps?.type === "object" || additionalProps?.properties;

  while (true) {
    const items = Object.entries(dict).map(([k, v]) => ({
      key: `key.${k}`,
      label: k,
      value: typeof v === "object" && v !== null ? `{${Object.keys(v as object).length} keys}` : String(v ?? ""),
    }));
    items.push({ key: "+add", label: "+ Add key", value: "" });

    const sections = [{ title: "", items }];
    const actions: { key: string; label: string }[] = [];
    actions.push({ key: "q", label: "Back" });

    const choice = await askDashboard(name, sections, actions, { selected: lastSelected });

    if (choice === null || (choice.type === "action" && choice.key === "q")) {
      return dirty;
    }

    if (choice.type === "item") {
      lastSelected = choice.key;
      if (choice.key === "+add") {
        const newKey = askValue("Key", "");
        if (newKey === null || !newKey) continue;
        if (isObjectValues) {
          dict[newKey] = {};
          dirty = true;
          const valueSchema = additionalProps?.properties as Record<string, SchemaProperty> | undefined;
          if (valueSchema) {
            await editObjectProperties(dict[newKey] as Record<string, unknown>, valueSchema, descriptions, `${parentPath}.${name}`);
          }
        } else {
          const value = askValue("Value", "");
          if (value !== null && value !== "") {
            dict[newKey] = value;
            dirty = true;
          }
        }
      } else if (choice.key.startsWith("key.")) {
        const k = choice.key.slice(4);
        if (isObjectValues) {
          const valueSchema = additionalProps?.properties as Record<string, SchemaProperty> | undefined;
          if (valueSchema) {
            const objVal = (dict[k] ?? {}) as Record<string, unknown>;
            dict[k] = objVal;
            if (await editObjectProperties(objVal, valueSchema, descriptions, `${parentPath}.${name}`)) {
              dirty = true;
            }
          }
        } else {
          const action = await ask(k, [
            { label: "Edit", description: `Current: ${String(dict[k] ?? "")}` },
            { label: "Remove", description: "Delete this key" },
          ]);
          if (action === 0) {
            const value = askValue(k, String(dict[k] ?? ""));
            if (value !== null) {
              if (value) { dict[k] = value; } else { delete dict[k]; }
              dirty = true;
            }
          } else if (action === 1) {
            delete dict[k];
            dirty = true;
            lastSelected = undefined;
          }
        }
      }
    }
  }
}

async function editObjectArrayProperty(
  container: Record<string, unknown>,
  name: string,
  prop: SchemaProperty,
  descriptions: Record<string, string>,
  parentPath: string,
): Promise<boolean> {
  let arr = Array.isArray(container[name]) ? [...(container[name] as Record<string, unknown>[])] : [];
  let dirty = false;
  let lastSelected: string | undefined;

  const items_schema = ((prop as Record<string, unknown>).items as Record<string, unknown> | undefined);
  const itemProps = items_schema?.properties as Record<string, SchemaProperty> | undefined;

  while (true) {
    const items = arr.map((obj, i) => {
      const displayName = String(obj.Name ?? obj.Type ?? obj.name ?? obj.type ?? `#${i + 1}`);
      const parts: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        if (v !== null && v !== undefined && typeof v !== "object") parts.push(`${k}=${v}`);
        if (parts.length >= 3) break;
      }
      return { key: `item.${i}`, label: displayName, value: parts.join(", ") };
    });
    items.push({ key: "+add", label: "+ Add", value: "" });

    const sections = [{ title: "", items }];
    const actions: { key: string; label: string }[] = [];
    if (arr.length > 0) actions.push({ key: "r", label: "Remove last" });
    actions.push({ key: "q", label: "Back" });

    const choice = await askDashboard(name, sections, actions, { selected: lastSelected });

    if (choice === null || (choice.type === "action" && choice.key === "q")) {
      if (dirty) container[name] = arr;
      return dirty;
    }

    if (choice.type === "action" && choice.key === "r" && arr.length > 0) {
      arr.pop();
      dirty = true;
      lastSelected = undefined;
      continue;
    }

    if (choice.type === "item") {
      lastSelected = choice.key;
      if (choice.key === "+add") {
        const newObj: Record<string, unknown> = {};
        if (itemProps) {
          for (const [k, v] of Object.entries(itemProps)) {
            if (v.default !== undefined) newObj[k] = v.default;
          }
        }
        arr.push(newObj);
        dirty = true;
        if (itemProps) {
          await editObjectProperties(newObj, itemProps, descriptions, `${parentPath}.${name}`);
        }
      } else if (choice.key.startsWith("item.")) {
        const idx = parseInt(choice.key.slice(5), 10);
        if (itemProps) {
          if (await editObjectProperties(arr[idx], itemProps, descriptions, `${parentPath}.${name}`)) {
            dirty = true;
          }
        }
      }
    }
  }
}

async function editObjectProperties(
  obj: Record<string, unknown>,
  schemaProps: Record<string, SchemaProperty>,
  descriptions: Record<string, string>,
  parentPath: string,
): Promise<boolean> {
  let dirty = false;
  let lastSelected: string | undefined;

  while (true) {
    const items = Object.entries(schemaProps).map(([key, prop]) => {
      const value = obj[key];
      const descPath = parentPath ? `${parentPath}.${key}` : key;
      return {
        key,
        label: key,
        value: formatPropertyValue(value, prop),
        help: descriptions[descPath],
      };
    });

    const sections = [{ title: "", items }];
    const actions = [{ key: "q", label: "Back" }];
    const title = parentPath.split(".").pop() || "Settings";

    const choice = await askDashboard(title, sections, actions, { selected: lastSelected });

    if (choice === null || (choice.type === "action" && choice.key === "q")) {
      return dirty;
    }

    if (choice.type === "item") {
      lastSelected = choice.key;
      const prop = schemaProps[choice.key];
      if (!prop) continue;

      const propType = classifyProperty(prop);

      switch (propType) {
        case "boolean":
        case "enum":
        case "string":
        case "number": {
          if (await editSchemaItem(obj, choice.key, prop)) dirty = true;
          break;
        }
        case "object": {
          const nestedSchema = getNestedProperties(prop);
          if (nestedSchema) {
            const nestedObj = (obj[choice.key] ?? {}) as Record<string, unknown>;
            obj[choice.key] = nestedObj;
            if (await editObjectProperties(nestedObj, nestedSchema, descriptions, `${parentPath}.${choice.key}`)) {
              dirty = true;
            }
            if (Object.keys(nestedObj).length === 0) delete obj[choice.key];
          }
          break;
        }
        case "array-scalar": {
          if (await editArrayProperty(obj, choice.key, prop)) dirty = true;
          break;
        }
        case "array-object": {
          if (await editObjectArrayProperty(obj, choice.key, prop, descriptions, parentPath)) dirty = true;
          break;
        }
        case "dictionary": {
          if (await editDictionaryProperty(obj, choice.key, prop, descriptions, parentPath)) dirty = true;
          break;
        }
      }
    }
  }
}

function buildConnectionDashboard(parsed: ParsedConnectionString) {
  const sections: { title: string; items: { key: string; label: string; value: string; help?: string }[] }[] = [];

  // Group set parameters by category
  const categories = [...new Set(CONN_PARAMS.map((p) => p.category))];
  for (const cat of categories) {
    const items: { key: string; label: string; value: string; help?: string }[] = [];
    for (const param of CONN_PARAMS.filter((p) => p.category === cat)) {
      if (param.name in parsed) {
        const display = param.name === "Password" || param.name === "SSL Password"
          ? (/^\{.+\}$/.test(parsed[param.name]) ? parsed[param.name] : "****")
          : parsed[param.name];
        items.push({
          key: `param.${param.name}`,
          label: param.name,
          value: display || "(empty)",
          help: param.help,
        });
      }
    }
    // Also include any unknown keys that aren't in the catalog
    if (cat === "Misc") {
      for (const key of Object.keys(parsed)) {
        if (!CONN_PARAM_ORDER.includes(key)) {
          items.push({
            key: `param.${key}`,
            label: key,
            value: parsed[key] || "(empty)",
            help: "Custom parameter (not in standard Npgsql catalog).",
          });
        }
      }
    }
    if (items.length > 0) {
      sections.push({ title: cat, items });
    }
  }

  if (sections.length === 0) {
    sections.push({ title: "", items: [{ key: "+add", label: "+ Add parameter", value: "", help: "Add a connection parameter." }] });
  }

  return sections;
}

async function chooseNewParam(parsed: ParsedConnectionString): Promise<string | undefined> {
  const categories = [...new Set(CONN_PARAMS.map((p) => p.category))];
  const availableByCategory: Record<string, ConnParamDef[]> = {};
  for (const cat of categories) {
    const available = CONN_PARAMS.filter((p) => p.category === cat && !(p.name in parsed));
    if (available.length > 0) availableByCategory[cat] = available;
  }

  const catNames = Object.keys(availableByCategory);
  if (catNames.length === 0) {
    return undefined; // all params are set
  }

  const catChoice = await ask("Category", catNames.map((c) => ({
    label: c,
    description: `${availableByCategory[c].length} parameter${availableByCategory[c].length > 1 ? "s" : ""}`,
  })));
  if (catChoice === -1) return undefined;

  const params = availableByCategory[catNames[catChoice]];
  const paramChoice = await ask("Parameter", params.map((p) => ({
    label: p.name,
    description: p.default ? `default: ${p.default}` : "",
    help: p.help,
  })));
  if (paramChoice === -1) return undefined;

  return params[paramChoice].name;
}

async function editConnectionDashboard(
  configData: Record<string, unknown>,
  header: string,
  filePath: string,
  config: PgdevConfig,
  connName: string,
  isNew: boolean,
  descriptions: Record<string, string>,
): Promise<string | undefined> {
  const connStrings = (configData.ConnectionStrings ?? {}) as Record<string, string>;
  const parsed = parseConnectionString(connStrings[connName] ?? "");

  if (isNew) {
    const ENV_DEFAULTS: Record<string, string> = {
      Host: "{PGHOST}", Port: "{PGPORT}", Database: "{PGDATABASE}",
      Username: "{PGUSER}", Password: "{PGPASSWORD}",
    };
    for (const field of CONN_FIELD_ORDER) {
      if (!(field in parsed)) parsed[field] = ENV_DEFAULTS[field] ?? "";
    }
  }

  let dirty = isNew;
  let lastSelected: string | undefined;
  let lastStatus: string | undefined;

  if (isNew) {
    lastStatus = "Defaults use {ENV_VAR} placeholders — resolved at runtime when ParseEnvironmentVariables is enabled.";
  }

  while (true) {
    const sections = buildConnectionDashboard(parsed);
    const actions: { key: string; label: string }[] = [
      { key: "a", label: "Add parameter" },
      { key: "r", label: "Rename" },
      { key: "x", label: "Delete connection" },
      { key: "s", label: "Save" },
      { key: "q", label: "Back" },
    ];

    const choice = await askDashboard(
      `Connection: ${connName}`,
      sections,
      actions,
      { selected: lastSelected, status: lastStatus },
    );
    lastStatus = undefined;

    if (choice === null || (choice.type === "action" && choice.key === "q")) {
      if (dirty) {
        if (askConfirm("Save changes?", true)) {
          connStrings[connName] = serializeConnectionString(parsed);
          configData.ConnectionStrings = connStrings;
          await writeJsonConfig(filePath, configData, header, descriptions);
          return `Saved ${filePath}`;
        }
      }
      return undefined;
    }

    if (choice.type === "action") {
      if (choice.key === "a") {
        const paramName = await chooseNewParam(parsed);
        if (paramName) {
          const def = getConnParamDef(paramName);
          if (def?.type === "boolean") {
            parsed[paramName] = def.default === "true" ? "false" : "true";
            dirty = true;
            lastStatus = `Added ${paramName} = ${parsed[paramName]}`;
          } else if (def?.enumValues) {
            const enumChoice = await ask(paramName, def.enumValues.map((v) => ({
              label: v,
              description: v === def.default ? "(default)" : "",
            })));
            if (enumChoice >= 0) {
              parsed[paramName] = def.enumValues[enumChoice];
              dirty = true;
              lastStatus = `Added ${paramName} = ${parsed[paramName]}`;
            }
          } else {
            const isMask = paramName === "Password" || paramName === "SSL Password";
            const value = askValue(paramName, def?.default ?? "", isMask ? { mask: true } : undefined);
            if (value !== null) {
              parsed[paramName] = value;
              dirty = true;
              lastStatus = `Added ${paramName}`;
            }
          }
          lastSelected = `param.${paramName}`;
        }
      } else if (choice.key === "r") {
        const newName = prompt(`  ${pc.bold("New name")} ${pc.dim(`[${connName}]`)}>`);
        const trimmed = (newName ?? "").trim();
        if (trimmed && trimmed !== connName) {
          if (trimmed in connStrings) {
            lastStatus = `"${trimmed}" already exists.`;
          } else {
            connStrings[trimmed] = connStrings[connName];
            delete connStrings[connName];
            configData.ConnectionStrings = connStrings;
            await writeJsonConfig(filePath, configData, header, descriptions);
            return `Renamed "${connName}" to "${trimmed}"`;
          }
        }
      } else if (choice.key === "x") {
        if (askConfirm(`Delete connection "${connName}"?`)) {
          delete connStrings[connName];
          configData.ConnectionStrings = connStrings;
          await writeJsonConfig(filePath, configData, header, descriptions);
          return `Deleted "${connName}"`;
        }
      } else if (choice.key === "s") {
        connStrings[connName] = serializeConnectionString(parsed);
        configData.ConnectionStrings = connStrings;
        await writeJsonConfig(filePath, configData, header, descriptions);
        dirty = false;
        lastStatus = `Saved ${filePath}`;
        if (askConfirm("Validate?")) {
          const result = await validateNpgsqlRest(config, filePath);
          lastStatus = formatValidateResult(result, config.verbose);
        }
      }
      continue;
    }

    // Item selected
    if (choice.type === "item") {
      lastSelected = choice.key;

      if (choice.key === "+add") {
        const paramName = await chooseNewParam(parsed);
        if (paramName) {
          const def = getConnParamDef(paramName);
          if (def?.type === "boolean") {
            parsed[paramName] = def.default === "true" ? "false" : "true";
            dirty = true;
          } else if (def?.enumValues) {
            const enumChoice = await ask(paramName, def.enumValues.map((v) => ({
              label: v,
              description: v === def.default ? "(default)" : "",
            })));
            if (enumChoice >= 0) {
              parsed[paramName] = def.enumValues[enumChoice];
              dirty = true;
            }
          } else {
            const isMask = paramName === "Password" || paramName === "SSL Password";
            const value = askValue(paramName, def?.default ?? "", isMask ? { mask: true } : undefined);
            if (value !== null) {
              parsed[paramName] = value;
              dirty = true;
            }
          }
          lastSelected = `param.${paramName}`;
        }
        continue;
      }

      if (choice.key.startsWith("param.")) {
        const paramName = choice.key.slice("param.".length);
        const def = getConnParamDef(paramName);

        const editAction = await ask(paramName, [
          { label: "Edit value", description: parsed[paramName] === "Password" ? "****" : (parsed[paramName] || "(empty)") },
          { label: "Remove parameter", description: `Remove ${paramName} from connection string` },
        ]);

        if (editAction === 0) {
          if (def?.type === "boolean") {
            const current = parsed[paramName]?.toLowerCase();
            parsed[paramName] = current === "true" ? "false" : "true";
            dirty = true;
            lastStatus = `${paramName} = ${parsed[paramName]}`;
          } else if (def?.enumValues) {
            const enumChoice = await ask(paramName, def.enumValues.map((v) => ({
              label: v,
              description: v === def.default ? "(default)" : "",
            })));
            if (enumChoice >= 0) {
              parsed[paramName] = def.enumValues[enumChoice];
              dirty = true;
              lastStatus = `${paramName} = ${parsed[paramName]}`;
            }
          } else {
            const isMask = paramName === "Password" || paramName === "SSL Password";
            const value = askValue(paramName, parsed[paramName] ?? "", isMask ? { mask: true } : undefined);
            if (value === null) continue;
            parsed[paramName] = value;
            dirty = true;
            lastStatus = `${paramName} = ${isMask ? "****" : value}`;
          }
        } else if (editAction === 1) {
          delete parsed[paramName];
          dirty = true;
          lastStatus = `Removed ${paramName}`;
          lastSelected = undefined;
        }
      }
    }
  }
}

function buildNpgsqlRestDashboardSections(
  configData: Record<string, unknown>,
  topLevelProps: Record<string, SchemaProperty>,
  configProps: Record<string, SchemaProperty>,
  objectSections: Record<string, SchemaProperty>,
  descriptions: Record<string, string>,
) {
  const sections: { title: string; items: { key: string; label: string; value: string; help?: string }[] }[] = [];

  // Top Level
  const topLevelNames = Object.keys(topLevelProps);
  if (topLevelNames.length > 0) {
    sections.push({
      title: "Top Level",
      items: topLevelNames.map((name) => {
        const prop = topLevelProps[name];
        const value = configData[name] ?? prop.default;
        const display = value === null || value === undefined ? "(not set)" : String(value);
        return { key: name, label: name, value: display, help: descriptions[name] };
      }),
    });
  }

  // Config Settings
  const configSection = (configData.Config ?? {}) as Record<string, unknown>;
  const configNames = Object.keys(configProps);
  if (configNames.length > 0) {
    sections.push({
      title: "Config Settings",
      items: configNames.map((name) => {
        const prop = configProps[name];
        const value = configSection[name] ?? prop.default;
        const display = value === null || value === undefined ? "(not set)" : String(value);
        return { key: `Config.${name}`, label: name, value: display, help: descriptions[`Config.${name}`] };
      }),
    });
  }

  // Connection Strings
  const connStrings = (configData.ConnectionStrings ?? {}) as Record<string, string>;
  const connItems = Object.keys(connStrings).map((name) => ({
    key: `ConnectionStrings.${name}`,
    label: name,
    value: maskConnectionString(connStrings[name]),
    help: descriptions["ConnectionStrings"],
  }));
  connItems.push({
    key: "ConnectionStrings.+new",
    label: "+ Add new",
    value: "",
    help: "Add a new named connection string",
  });
  sections.push({ title: "Connection Strings", items: connItems });

  // Object Sections
  const sectionNames = Object.keys(objectSections);
  if (sectionNames.length > 0) {
    sections.push({
      title: "Sections",
      items: sectionNames.map((name) => ({
        key: `Section.${name}`,
        label: name,
        value: formatSectionStatus(configData[name]),
        help: descriptions[name],
      })),
    });
  }

  return sections;
}

// --- NpgsqlRest config dashboard ---

async function editNpgsqlRestDashboard(config: PgdevConfig): Promise<void> {
  let lastSelected: string | undefined;
  let lastStatus: string | undefined;
  let chosenFileIndex = -1; // -1 = auto-pick primary file

  while (true) {
    const currentConfig = await loadConfig();
    const files = discoverConfigFiles(currentConfig);
    const existing: ConfigFileRef[] = [];
    for (const f of files) {
      const fp = resolve(process.cwd(), f.path);
      if (await Bun.file(fp).exists()) existing.push(f);
    }

    if (existing.length === 0) {
      // Show a one-item ask() so the message appears cleanly, not above a dashboard
      await ask("NpgsqlRest config files not found", [
        { label: "Back", description: "Use Tools Setup → NpgsqlRest Config Files to configure" },
      ]);
      return;
    }

    const chosenFile = chosenFileIndex >= 0 && chosenFileIndex < existing.length
      ? existing[chosenFileIndex]
      : existing.find((f) => !f.optional) ?? existing[0];
    const fullPath = resolve(process.cwd(), chosenFile.path);
    const result = await readJsonConfig(fullPath);

    if (!result) {
      lastStatus = `Failed to read ${chosenFile.path}`;
      continue;
    }

    const schema = await fetchConfigSchema(currentConfig);
    const descriptions = extractDescriptions(schema);
    const topLevelProps = getSchemaTopLevel(schema);
    const configProps = getSchemaSection(schema, "Config");
    const objectSections = getSchemaObjectSections(schema);

    const sections = buildNpgsqlRestDashboardSections(result.data, topLevelProps, configProps, objectSections, descriptions);

    const actions: { key: string; label: string }[] = [];
    if (existing.length > 1) {
      actions.push({ key: "f", label: `Switch file (${chosenFile.path.split("/").pop()})` });
    }
    actions.push({ key: "t", label: "Validate" });
    actions.push({ key: "q", label: "Back" });

    const choice = await askDashboard(
      `NpgsqlRest config — ${chosenFile.path}`,
      sections,
      actions,
      { selected: lastSelected, status: lastStatus },
    );

    if (choice === null || (choice.type === "action" && choice.key === "q")) {
      break;
    }

    if (choice.type === "action") {
      if (choice.key === "f") {
        const fileChoice = await ask(
          "Which config file?",
          existing.map((f) => ({ label: f.path, description: f.optional ? "(optional)" : "" })),
        );
        if (fileChoice >= 0) {
          chosenFileIndex = fileChoice;
        }
        lastSelected = undefined;
      } else if (choice.key === "t") {
        const validateResult = await validateNpgsqlRest(currentConfig, fullPath);
        lastStatus = formatValidateResult(validateResult, currentConfig.verbose);
        lastSelected = undefined;
      }
      continue;
    }

    // Item selected
    lastSelected = choice.key;
    lastStatus = undefined;

    if (choice.key.startsWith("ConnectionStrings.")) {
      const connName = choice.key.slice("ConnectionStrings.".length);
      if (connName === "+new") {
        const nameInput = prompt(`  ${pc.bold("Connection name")} ${pc.dim("[Default]")}>`);
        const newName = (nameInput ?? "").trim() || "Default";
        const connStrings = (result.data.ConnectionStrings ?? {}) as Record<string, string>;
        if (newName in connStrings) {
          lastStatus = `"${newName}" already exists. Select it from the dashboard.`;
          continue;
        }
        connStrings[newName] = "";
        result.data.ConnectionStrings = connStrings;
        lastStatus = await editConnectionDashboard(result.data, result.header, fullPath, config, newName, true, descriptions);
        lastSelected = `ConnectionStrings.${newName}`;
      } else {
        lastStatus = await editConnectionDashboard(result.data, result.header, fullPath, config, connName, false, descriptions);
      }
    } else if (choice.key.startsWith("Config.")) {
      const name = choice.key.slice("Config.".length);
      const prop = configProps[name];
      if (prop) {
        const configSection = (result.data.Config ?? {}) as Record<string, unknown>;
        if (await editSchemaItem(configSection, name, prop)) {
          result.data.Config = configSection;
          await writeJsonConfig(fullPath, result.data, result.header, descriptions);
          lastStatus = `Saved ${chosenFile.path}`;
        }
      }
    } else if (choice.key.startsWith("Section.")) {
      const sectionName = choice.key.slice("Section.".length);
      const sectionProp = objectSections[sectionName];
      if (sectionProp) {
        const sectionSchema = getNestedProperties(sectionProp);
        if (sectionSchema) {
          const sectionData = (result.data[sectionName] ?? {}) as Record<string, unknown>;
          result.data[sectionName] = sectionData;
          if (await editObjectProperties(sectionData, sectionSchema, descriptions, sectionName)) {
            if (Object.keys(sectionData).length === 0) delete result.data[sectionName];
            await writeJsonConfig(fullPath, result.data, result.header, descriptions);
            lastStatus = `Saved ${chosenFile.path}`;
          }
        }
      }
    } else {
      // Top-level setting
      const prop = topLevelProps[choice.key];
      if (prop) {
        if (await editSchemaItem(result.data, choice.key, prop)) {
          await writeJsonConfig(fullPath, result.data, result.header, descriptions);
          lastStatus = `Saved ${chosenFile.path}`;
        }
      }
    }
  }
}

// --- pgdev connection testing ---

async function testPgdevConnection(config: PgdevConfig): Promise<string> {
  if (isSharedConnection(config.connection)) {
    const configFile = config.connection.config_file;
    if (!configFile) return pc.yellow("No config file set.");

    const fullPath = resolve(process.cwd(), configFile);
    const configResult = await readJsonConfig(fullPath);
    if (!configResult) return error(`Failed to read ${configFile}`);

    const connStrings = (configResult.data.ConnectionStrings ?? {}) as Record<string, string>;
    const connKeys = Object.keys(connStrings);
    if (connKeys.length === 0) return error(`No connection strings in ${configFile}`);

    // Resolution: pgdev.toml connection_name > NpgsqlRest.ConnectionName > first available
    const npgsqlRestSection = (configResult.data.NpgsqlRest ?? {}) as Record<string, unknown>;
    const connName = config.connection.connection_name
      ?? (npgsqlRestSection.ConnectionName as string | null)
      ?? connKeys[0];

    const connStr = connStrings[connName];
    if (!connStr) return error(`Connection "${connName}" not found in ${configFile}`);

    // Resolve env vars using NpgsqlRest's own env settings
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

    const connResult = await testConnectionFields(config, {
      host: parsed.Host || "localhost",
      port: parsed.Port || "5432",
      database: parsed.Database || "",
      username: parsed.Username || "",
      password: parsed.Password || "",
    });
    const lines: string[] = [];
    if (config.verbose && connResult.cmd.length > 0) {
      lines.push(pc.cyan(formatCmd(connResult.cmd)));
    }
    if (connResult.success) {
      lines.push(success(`Connection OK — shared "${connName}" from ${configFile}`));
      if (connResult.version) lines.push(pc.dim(`  ${connResult.version}`));
    } else {
      lines.push(pc.red(`Connection failed: ${connResult.error}`));
    }
    return lines.join("\n");
  } else {
    const conn = config.connection;
    const envDict = await buildPgdevEnvDict(config.env_file);
    const warnings: string[] = [];
    const connResult = await testConnectionFields(config, {
      host: resolveConnectionField(conn.host ?? "", envDict, warnings),
      port: resolveConnectionField(conn.port ?? "", envDict, warnings),
      database: resolveConnectionField(conn.database ?? "", envDict, warnings),
      username: resolveConnectionField(conn.username ?? "", envDict, warnings),
      password: resolveConnectionField(conn.password ?? "", envDict, warnings),
    });
    const lines: string[] = [];
    if (warnings.length > 0) {
      lines.push(pc.yellow(warnings.join(", ")));
    }
    if (config.verbose && connResult.cmd.length > 0) {
      lines.push(pc.cyan(formatCmd(connResult.cmd)));
    }
    if (connResult.success) {
      lines.push(success("Connection OK"));
      if (connResult.version) lines.push(pc.dim(`  ${connResult.version}`));
    } else {
      lines.push(pc.red(`Connection failed: ${connResult.error}`));
    }
    return lines.join("\n");
  }
}

// --- pgdev environment status ---

function environmentStatus(config: PgdevConfig): string {
  const parts: string[] = [];
  if (config.env_file) parts.push(`env: ${config.env_file}`);
  if (isSharedConnection(config.connection)) {
    parts.push("conn: shared");
  } else if (config.connection.database) {
    parts.push("conn: independent");
  }
  return parts.length > 0 ? parts.join(", ") : "not configured";
}

// --- pgdev environment dashboard ---

function buildPgdevEnvironmentDashboard(config: PgdevConfig) {
  const sections: { title: string; items: { key: string; label: string; value: string; help?: string }[] }[] = [
    {
      title: "Environment",
      items: [
        {
          key: "env_file",
          label: "Env file",
          value: config.env_file ?? "(not set)",
          help: "Path to a .env file with environment variables.\n{ENV_VAR} placeholders in pgdev.toml values will be resolved using these variables.",
        },
      ],
    },
  ];

  const shared = isSharedConnection(config.connection);
  const connItems: { key: string; label: string; value: string; help?: string }[] = [
    {
      key: "conn_mode",
      label: "Mode",
      value: shared ? "shared" : "independent",
      help: "shared: read connection from an NpgsqlRest config file.\nindependent: own connection settings in pgdev.toml.",
    },
  ];

  if (shared) {
    connItems.push({
      key: "conn_config_file",
      label: "Config file",
      value: config.connection.config_file ?? "(not set)",
      help: "NpgsqlRest config file to read the connection string from.",
    });
    connItems.push({
      key: "conn_name",
      label: "Connection name",
      value: config.connection.connection_name ?? "Default",
      help: "Named connection string within the config file.",
    });
  } else {
    const conn = config.connection;
    const maskValue = (v: string | undefined) => {
      if (!v) return "(not set)";
      return /^\{.+\}$/.test(v) ? v : "****";
    };
    connItems.push({
      key: "conn_host",
      label: "Host",
      value: conn.host ?? "(not set)",
      help: "PostgreSQL server hostname or IP.\nUse {PGHOST} for env var placeholder.",
    });
    connItems.push({
      key: "conn_port",
      label: "Port",
      value: conn.port ?? "(not set)",
      help: "PostgreSQL server port.\nUse {PGPORT} for env var placeholder.",
    });
    connItems.push({
      key: "conn_database",
      label: "Database",
      value: conn.database ?? "(not set)",
      help: "PostgreSQL database name.\nUse {PGDATABASE} for env var placeholder.",
    });
    connItems.push({
      key: "conn_username",
      label: "Username",
      value: conn.username ?? "(not set)",
      help: "PostgreSQL username.\nUse {PGUSER} for env var placeholder.",
    });
    connItems.push({
      key: "conn_password",
      label: "Password",
      value: maskValue(conn.password),
      help: "PostgreSQL password.\nUse {PGPASSWORD} for env var placeholder.",
    });
  }

  sections.push({ title: "Database Connection", items: connItems });

  sections.push({
    title: "",
    items: [{
      key: "test_connection",
      label: "Test connection",
      value: "",
      help: "Run SELECT version() against the configured database to verify connectivity.",
    }],
  });

  return sections;
}

async function pickSharedConfigFile(config: PgdevConfig): Promise<string | undefined> {
  const files = discoverConfigFiles(config);
  const existing: ConfigFileRef[] = [];
  for (const f of files) {
    const fullPath = resolve(process.cwd(), f.path);
    if (await Bun.file(fullPath).exists()) existing.push(f);
  }

  if (existing.length === 0) {
    return "No config files found. Use Tools Setup → NpgsqlRest Config Files to create them.";
  }

  const fileChoice = await ask(
    "Which config file?",
    existing.map((f) => ({ label: f.path, description: f.optional ? "(optional)" : "" })),
  );
  if (fileChoice === -1) return undefined;

  await updateConfig("connection", "config_file", existing[fileChoice].path);
  return `connection.config_file = "${existing[fileChoice].path}"`;
}

async function pickConnectionName(config: PgdevConfig): Promise<string | undefined> {
  const configFile = config.connection.config_file;
  if (!configFile) {
    return "Set config file first.";
  }

  const fullPath = resolve(process.cwd(), configFile);
  const result = await readJsonConfig(fullPath);
  if (!result) {
    return `Failed to read ${configFile}`;
  }

  const connStrings = (result.data.ConnectionStrings ?? {}) as Record<string, string>;
  const connNames = Object.keys(connStrings);

  if (connNames.length === 0) {
    return "No connection strings found. Use NpgsqlRest config to add one.";
  }

  if (connNames.length === 1) {
    await updateConfig("connection", "connection_name", connNames[0]);
    return `connection.connection_name = "${connNames[0]}"`;
  }

  const connChoice = await ask(
    "Which connection?",
    connNames.map((name) => ({
      label: name,
      description: maskConnectionString(connStrings[name]),
    })),
  );
  if (connChoice === -1) return undefined;

  await updateConfig("connection", "connection_name", connNames[connChoice]);
  return `connection.connection_name = "${connNames[connChoice]}"`;
}

async function editPgdevEnvironment(config: PgdevConfig): Promise<void> {
  let currentConfig = config;
  let lastSelected: string | undefined;
  let lastStatus: string | undefined;

  while (true) {
    const sections = buildPgdevEnvironmentDashboard(currentConfig);
    const actions = [
      { key: "q", label: "Back" },
    ];

    const choice = await askDashboard("pgdev environment", sections, actions, { selected: lastSelected, status: lastStatus });

    if (choice === null || (choice.type === "action" && choice.key === "q")) {
      break;
    }

    if (choice.type === "item") {
      if (choice.key === "test_connection") {
        lastStatus = await testPgdevConnection(currentConfig);
        lastSelected = "test_connection";
        currentConfig = await loadConfig();
        continue;
      }
      lastSelected = choice.key;
      lastStatus = undefined;

      if (choice.key === "env_file") {
        const current = currentConfig.env_file ?? "";
        const value = askValue("Env file", current, { path: true });
        if (value !== null && value !== current) {
          if (value) {
            await updateConfig("", "env_file", value);
            lastStatus = `env_file = "${value}"`;
          } else {
            await updateConfig("", "env_file", "");
            lastStatus = "env_file cleared";
          }
        }
      } else if (choice.key === "conn_mode") {
        const currentlyShared = isSharedConnection(currentConfig.connection);
        const modeChoice = await ask("Connection mode", [
          { label: "shared", description: "Read connection from NpgsqlRest config file" },
          { label: "independent", description: "Own connection settings in pgdev.toml" },
        ]);
        if (modeChoice === 0 && !currentlyShared) {
          // Switch to shared: pick a config file
          lastStatus = await pickSharedConfigFile(currentConfig);
        } else if (modeChoice === 1 && currentlyShared) {
          // Switch to independent: remove config_file and connection_name
          await removeConfigKey("connection", "config_file");
          await removeConfigKey("connection", "connection_name");
          lastStatus = "Switched to independent connection mode";
        }
      } else if (choice.key === "conn_config_file") {
        lastStatus = await pickSharedConfigFile(currentConfig);
      } else if (choice.key === "conn_name") {
        lastStatus = await pickConnectionName(currentConfig);
      } else if (choice.key.startsWith("conn_")) {
        const fieldMap: Record<string, string> = {
          conn_host: "host",
          conn_port: "port",
          conn_database: "database",
          conn_username: "username",
          conn_password: "password",
        };
        const field = fieldMap[choice.key];
        if (field) {
          const current = currentConfig.connection[field as keyof typeof currentConfig.connection] as string ?? "";
          const value = askValue(field.charAt(0).toUpperCase() + field.slice(1), current, { mask: field === "password" });
          if (value !== null && value !== current) {
            await updateConfig("connection", field, value);
            lastStatus = `connection.${field} = "${field === "password" ? "****" : value}"`;
          }
        }
      }

      currentConfig = await loadConfig();
    }
  }
}

// --- Project directories ---

function getConfigDir(config: PgdevConfig): string {
  for (const cmd of Object.values(config.npgsqlrest.commands)) {
    for (const token of cmd.trim().split(/\s+/)) {
      if (token.endsWith(".json") && !token.startsWith("--")) {
        const parts = token.replace(/^\.\//, "").split("/");
        if (parts.length > 1) return parts.slice(0, -1).join("/");
      }
    }
  }
  return "";
}

function validateProjectDir(
  dir: string,
  key: string,
  config: PgdevConfig,
): string | null {
  if (!dir) return null;

  const abs = resolve(process.cwd(), dir);

  // Check it's not a file
  try {
    const stat = statSync(abs);
    if (!stat.isDirectory()) return `"${dir}" exists but is not a directory`;
    // If existing, must be empty
    const entries = readdirSync(abs);
    if (entries.length > 0) return `"${dir}" is not empty`;
  } catch {
    // Doesn't exist yet — that's fine
  }

  // Normalize for comparison (strip leading ./ and trailing /)
  const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
  const normDir = norm(dir);

  // Can't overlap with config dir
  const configDir = getConfigDir(config);
  if (configDir && normDir === norm(configDir)) {
    return `"${dir}" is already used as the config directory`;
  }

  // Can't overlap with other project dirs
  const PROJECT_KEYS = ["routines_dir", "migrations_dir", "tests_dir"] as const;
  for (const otherKey of PROJECT_KEYS) {
    if (otherKey === key) continue;
    const otherDir = config.project[otherKey];
    if (otherDir && normDir === norm(otherDir)) {
      return `"${dir}" is already used as ${otherKey.replace("_dir", "")} directory`;
    }
  }

  return null;
}

async function handleProjectDir(
  key: "routines_dir" | "migrations_dir" | "tests_dir",
  label: string,
  config: PgdevConfig,
): Promise<string | undefined> {
  const current = config.project[key];
  const dir = askPath(label, current);
  if (dir === null) return undefined;

  if (dir === current) return undefined;

  if (!dir) {
    await updateConfig("project", key, "");
    return `project.${key} cleared`;
  }

  const err = validateProjectDir(dir, key, config);
  if (err) return err;

  // Create directory if it doesn't exist
  const abs = resolve(process.cwd(), dir);
  const msgs: string[] = [];
  try {
    statSync(abs);
  } catch {
    mkdirSync(abs, { recursive: true });
    msgs.push(`Created ${dir}`);
  }

  await updateConfig("project", key, dir);
  msgs.push(`project.${key} = "${dir}"`);
  return msgs.join("\n");
}

function projectDirStatus(value: string): string {
  if (!value) return "not set";
  try {
    const stat = statSync(resolve(process.cwd(), value));
    return stat.isDirectory() ? value : `${value} (not a directory)`;
  } catch {
    return `${value} (will be created)`;
  }
}

function projectStatus(config: PgdevConfig): string {
  const set = [config.project.routines_dir, config.project.migrations_dir, config.project.tests_dir].filter(Boolean);
  if (set.length === 0) return "not configured";
  return `${set.length} dir${set.length > 1 ? "s" : ""} configured`;
}

function schemasStatus(schemas: string[]): string {
  if (schemas.length === 0) return "all non-system schemas";
  return schemas.join(", ");
}

async function handleSchemas(config: PgdevConfig): Promise<string | undefined> {
  const result = await runPsqlQuery(config, config.commands.schemas_query);
  if (!result.ok) {
    const msg = pc.red(`Failed to query schemas: ${result.error}`);
    return config.verbose && result.cmd ? `${pc.cyan(result.cmd)}\n${msg}` : msg;
  }

  if (result.rows.length === 0) {
    return "No non-system schemas found in database.";
  }

  const selected = new Set(config.project.schemas);

  const save = (sel: Set<string>) => {
    const schemas = result.rows.filter((s) => sel.has(s));
    updateConfigArraySync("project", "schemas", schemas);
  };

  askMultiSelect("Schemas", result.rows, selected, save);
}

async function editProjectDirectories(config: PgdevConfig): Promise<void> {
  let currentConfig = config;
  let lastSelected: string | undefined;
  let lastStatus: string | undefined;

  while (true) {
    const sections = [
      {
        title: "",
        items: [
          {
            key: "routines_dir",
            label: "Routines directory",
            value: projectDirStatus(currentConfig.project.routines_dir),
            help: "Directory for SQL files containing PostgreSQL functions and procedures.\nThese define the REST API surface exposed by NpgsqlRest.",
          },
          {
            key: "migrations_dir",
            label: "Migrations directory",
            value: projectDirStatus(currentConfig.project.migrations_dir),
            help: "Directory for versioned migration SQL scripts.\nSupports up/down, repeatable before/after, ordering by convention or config.",
          },
          {
            key: "tests_dir",
            label: "Tests directory",
            value: projectDirStatus(currentConfig.project.tests_dir),
            help: "Directory for SQL test files.\nTest modes: single connection, template database per run, template database per file.",
          },
        ],
      },
    ];
    const actions = [{ key: "q", label: "Back" }];

    const choice = await askDashboard("Project settings", sections, actions, { selected: lastSelected, status: lastStatus });
    lastStatus = undefined;

    if (choice === null || (choice.type === "action" && choice.key === "q")) break;

    if (choice.type === "item") {
      lastSelected = choice.key;

      const key = choice.key as "routines_dir" | "migrations_dir" | "tests_dir";
      const labels: Record<string, string> = {
        routines_dir: "Routines directory",
        migrations_dir: "Migrations directory",
        tests_dir: "Tests directory",
      };
      lastStatus = await handleProjectDir(key, labels[key], currentConfig);
      currentConfig = await loadConfig();
    }
  }
}

// --- Main entry ---

export async function configCommand(config: PgdevConfig): Promise<void> {
  let currentConfig = config;
  let lastSelected: string | undefined;
  let lastStatus: string | undefined;

  while (true) {
    const sections = [
      {
        title: "",
        items: [
          {
            key: "tools",
            label: "Tools Setup",
            value: toolsStatus(currentConfig),
            help: "Configure tools used by pgdev (NpgsqlRest, PostgreSQL tools).\nDetect installations or install new ones.",
          },
          {
            key: "npgsqlrest_config",
            label: "NpgsqlRest config",
            value: configFilesStatus(currentConfig),
            help: "Edit NpgsqlRest JSON config files (settings, connection strings).\nCreates config files if not yet initialized.",
          },
          {
            key: "environment",
            label: "pgdev environment",
            value: environmentStatus(currentConfig),
            help: "Env file and database connection for pgdev tools.",
          },
        ],
      },
      {
        title: "Project Settings",
        items: [
          {
            key: "project",
            label: "Project directories",
            value: projectStatus(currentConfig),
            help: "Routines, migrations, and tests directories for SQL source files.",
          },
          {
            key: "schemas",
            label: "Project schemas",
            value: schemasStatus(currentConfig.project.schemas),
            help: "Select database schemas used by this project.\nEmpty means all non-system schemas.",
          },
          {
            key: "grants",
            label: "Track grants",
            value: currentConfig.project.grants ? "yes" : "no",
            help: "Track GRANT/REVOKE statements for routines.\nWhen enabled, pgdev parses and compares routine permissions,\nand sync includes ACL entries in dumped SQL files.",
          },
          {
            key: "ignore_body_whitespace",
            label: "Ignore body whitespace",
            value: currentConfig.project.ignore_body_whitespace ? "yes" : "no",
            help: "Ignore whitespace differences in routine bodies when comparing.\nWhen enabled, formatting-only changes (indentation, line breaks) are not reported as differences.",
          },
        ],
      },
    ];
    const actions = [{ key: "q", label: "Quit" }];

    const choice = await askDashboard("pgdev config", sections, actions, { selected: lastSelected, status: lastStatus });
    lastStatus = undefined;

    if (choice === null || (choice.type === "action" && choice.key === "q")) return;

    if (choice.type === "item") {
      lastSelected = choice.key;

      if (choice.key === "tools") {
        await editToolsSetup(currentConfig);
      } else if (choice.key === "npgsqlrest_config") {
        await editNpgsqlRestDashboard(currentConfig);
      } else if (choice.key === "environment") {
        await editPgdevEnvironment(currentConfig);
      } else if (choice.key === "project") {
        await editProjectDirectories(currentConfig);
      } else if (choice.key === "schemas") {
        lastStatus = await handleSchemas(currentConfig);
      } else if (choice.key === "grants") {
        const newValue = !currentConfig.project.grants;
        await updateConfigBool("project", "grants", newValue);
        lastStatus = `grants = ${newValue}`;
      } else if (choice.key === "ignore_body_whitespace") {
        const newValue = !currentConfig.project.ignore_body_whitespace;
        await updateConfigBool("project", "ignore_body_whitespace", newValue);
        lastStatus = `ignore_body_whitespace = ${newValue}`;
      }

      currentConfig = await loadConfig();
    }
  }
}
