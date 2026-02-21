import { $ } from "bun";
import { statSync, readdirSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type PgdevConfig, updateConfig, updateConfigArraySync, removeConfigKey, isSharedConnection } from "../config.ts";
import { success, error, info, pc, formatCmd, spinner } from "../utils/terminal.ts";
import { ask, askConfirm, askValue, askPath, askDashboard, askMultiSelect } from "../utils/prompt.ts";
import { readJsonConfig, writeJsonConfig } from "../utils/json.ts";
import { splitCommand } from "../cli.ts";
import { resolveEnvVars, loadEnvFile, buildPgdevEnvDict } from "../utils/env.ts";
import { runPsqlQuery } from "./exec.ts";
import { setupNpgsqlRest, setupPostgresTools } from "./setup.ts";
import { detectNpgsqlRest, detectPgTools, type PgInstallation } from "../utils/tools.ts";

// --- Key descriptions (from NpgsqlRest appsettings.json) ---

export const DESCRIPTIONS: Record<string, string> = {
  "ApplicationName":
    "The application name used to set the application name property in connection string\n" +
    'by "NpgsqlRest.SetApplicationNameInConnection" or the "NpgsqlRest.UseJsonApplicationName" settings.\n' +
    "It is the name of the top-level directory if set to null.",
  "EnvironmentName":
    "Production or Development",
  "Urls":
    "Specify the urls the web host will listen on.\n" +
    "See https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.hosting.hostingabstractionswebhostbuilderextensions.useurls",
  "StartupMessage":
    "Logs at startup, format placeholders:\n" +
    "{time} - startup time\n" +
    "{urls} - listening on urls\n" +
    "{version} - current version\n" +
    "{environment} - EnvironmentName\n" +
    "{application} - ApplicationName\n" +
    "\n" +
    "Note: This message is logged at Information level. To disable this message, set to empty string.",
  "Config":
    "Configuration settings",
  "Config.AddEnvironmentVariables":
    "Add the environment variables to configuration.\n" +
    "When enabled, environment variables will override the settings in this configuration file but can be overridden by command line arguments.\n" +
    "Complex hierarchical keys can be defined using double underscore as a separator.\n" +
    'For example, "ConnectionStrings__Default" environment variable will override the "ConnectionStrings.Default" setting in this configuration file.',
  "Config.ParseEnvironmentVariables":
    "When set, configuration values will be parsed for environment variables in the format {ENV_VAR_NAME}\n" +
    "and replaced with the value of the environment variable when available.",
  "Config.EnvFile":
    "Path to a .env file containing environment variables.\n" +
    "When AddEnvironmentVariables or ParseEnvironmentVariables is true and this file exists,\n" +
    "variables from this file will be loaded and made available for configuration parsing.\n" +
    "Format: KEY=VALUE (one per line)",
  "Config.ValidateConfigKeys":
    "Validate configuration keys against known defaults at startup.\n" +
    '"Ignore" - no validation\n' +
    '"Warning" - log warnings for unknown keys, continue startup (default)\n' +
    '"Error" - log errors for unknown keys and exit',
  "ConnectionStrings":
    "List of named connection strings to PostgreSQL databases.\n" +
    'The "Default" connection string is used when no connection name is specified.\n' +
    "For connection string definition see https://www.npgsql.org/doc/connection-string-parameters.html",
};

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

async function savePgTools(chosen: PgInstallation): Promise<void> {
  const psqlCmd = chosen.binDir ? `${chosen.binDir}/psql` : "psql";
  const pgDumpCmd = chosen.binDir ? `${chosen.binDir}/pg_dump` : "pg_dump";
  const pgRestoreCmd = chosen.binDir ? `${chosen.binDir}/pg_restore` : "pg_restore";

  await updateConfig("tools", "psql", psqlCmd);
  await updateConfig("tools", "pg_dump", pgDumpCmd);
  await updateConfig("tools", "pg_restore", pgRestoreCmd);

  console.log(info(`Config updated: tools.psql = "${psqlCmd}"`));
  console.log(info(`Config updated: tools.pg_dump = "${pgDumpCmd}"`));
  console.log(info(`Config updated: tools.pg_restore = "${pgRestoreCmd}"`));
}

async function handleNpgsqlRest(): Promise<void> {
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
      console.log(info(`Config updated: tools.npgsqlrest = "${result.command}"`));
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
}

async function handlePgTools(): Promise<void> {
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
      await savePgTools(chosen);
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
      await savePgTools(pgInstalls[choice]);
    } else if (choice === pgInstalls.length) {
      await setupPostgresTools();
    }
  }
}

// --- Tools Setup dashboard ---

async function editToolsSetup(config: PgdevConfig): Promise<void> {
  let currentConfig = config;
  let lastSelected: string | undefined;

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
        ],
      },
    ];
    const actions = [
      { key: "d", label: "Detect all tools" },
      { key: "q", label: "Back" },
    ];

    const choice = await askDashboard("Tools Setup", sections, actions, { selected: lastSelected });

    if (choice === null || (choice.type === "action" && choice.key === "q")) break;

    if (choice.type === "action" && choice.key === "d") {
      await handleNpgsqlRest();
      await handlePgTools();
      currentConfig = await loadConfig();
      lastSelected = undefined;
      continue;
    }

    if (choice.type === "item") {
      lastSelected = choice.key;
      if (choice.key === "npgsqlrest") {
        await handleNpgsqlRest();
      } else if (choice.key === "pgtools") {
        await handlePgTools();
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

async function writeIfConfirmed(path: string, content: string, description?: string): Promise<boolean> {
  if (await Bun.file(path).exists()) {
    if (!askConfirm(`${path} already exists. Overwrite?`)) {
      console.log(pc.dim(`  Skipped ${path}`));
      return false;
    }
  }
  await Bun.write(path, content);
  const desc = description ? `  ${pc.dim(description)}` : "";
  console.log(success(`Created ${path}`) + desc);
  return true;
}

async function appendToGitignore(entry: string): Promise<void> {
  const path = `${process.cwd()}/.gitignore`;
  const file = Bun.file(path);
  let content = (await file.exists()) ? await file.text() : "";

  if (content.split("\n").some((line) => line.trim() === entry)) return;

  const suffix = content.endsWith("\n") || content === "" ? "" : "\n";
  await Bun.write(path, content + suffix + entry + "\n");
  console.log(info(`Added ${entry} to .gitignore`));
}

async function mergeTomlCommands(
  commands: Record<string, string>,
): Promise<void> {
  console.log();
  console.log(`  ${pc.bold("pgdev.toml")} — the following commands will be set:`);
  console.log();
  console.log(pc.dim(`  [npgsqlrest.commands]`));
  for (const [name, value] of Object.entries(commands)) {
    console.log(pc.dim(`  ${name} = "${value}"`));
  }
  console.log();

  if (!askConfirm("Update pgdev.toml with these commands?", true)) {
    console.log(pc.dim(`  Skipped pgdev.toml`));
    return;
  }

  for (const [name, value] of Object.entries(commands)) {
    await updateConfig("npgsqlrest.commands", name, value);
  }

  console.log(success(`Updated pgdev.toml`));
}

async function initNpgsqlRest(): Promise<void> {
  const configDir = askPath("Config directory", "./config");

  const structureChoice = await ask("Config file structure?", [
    { label: "Single file", description: "One appsettings.json" },
    { label: "Dev + Prod", description: "Separate development and production configs" },
    { label: "Dev + Prod + Local", description: "Plus personal overrides, gitignored (recommended)" },
  ]);
  if (structureChoice === -1) return;

  // Create config directory if needed
  if (configDir !== ".") {
    const dir = `${process.cwd()}/${configDir}`;
    mkdirSync(dir, { recursive: true });
  }

  const prefix = configDir === "." ? "" : `${configDir}/`;
  const { appsettings, development, production, local } = CONFIG_FILES;

  // Create config files
  console.log();

  const commands: Record<string, string> = {};

  // Helper to build path with prefix for commands
  const p = (file: string) => `./${prefix}${file}`;

  if (structureChoice === 0) {
    // Single file
    await writeIfConfirmed(
      `${prefix}${appsettings.file}`,
      configHeader(appsettings.description) + "{}\n",
      appsettings.description,
    );
    commands.dev = p("appsettings.json");
    commands.validate = `${p("appsettings.json")} --validate`;
  } else {
    // Dev + Prod (with or without local)
    await writeIfConfirmed(
      `${prefix}${development.file}`,
      configHeader(development.description) + "{}\n",
      development.description,
    );
    await writeIfConfirmed(
      `${prefix}${production.file}`,
      configHeader(production.description) + "{}\n",
      production.description,
    );

    if (structureChoice === 2) {
      // + Local
      await writeIfConfirmed(
        `${prefix}${local.file}`,
        configHeader(local.description) + "{}\n",
        local.description,
      );
      await appendToGitignore(`${prefix}${local.file}`);
      commands.dev = `${p("production.json")} --optional ${p("development.json")} --optional ${p("local.json")}`;
      commands.validate = `${p("production.json")} --optional ${p("development.json")} --optional ${p("local.json")} --validate`;
    } else {
      commands.dev = `${p("production.json")} --optional ${p("development.json")}`;
      commands.validate = `${p("production.json")} --optional ${p("development.json")} --validate`;
    }
    commands.serve = p("production.json");
    commands["validate-prod"] = `${p("production.json")} --validate`;
  }

  await mergeTomlCommands(commands);

  console.log();
  console.log(success("NpgsqlRest config files initialized"));
  if (commands.serve) {
    console.log(pc.dim(`  Run ${pc.bold("pgdev dev")} to start with development config`));
    console.log(pc.dim(`  Run ${pc.bold("pgdev serve")} to start with production config`));
  } else {
    console.log(pc.dim(`  Run ${pc.bold("pgdev dev")} to start`));
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
  // Canonical order first
  for (const key of CONN_FIELD_ORDER) {
    if (key in parsed) {
      parts.push(`${key}=${parsed[key]}`);
    }
  }
  // Then any remaining keys
  for (const [key, value] of Object.entries(parsed)) {
    if (!CONN_FIELD_ORDER.includes(key)) {
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
    lines.push(pc.dim(formatCmd(output.cmd)));
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

// --- Connection testing ---

interface ConnectionFields {
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
}

function resolveConnectionField(value: string, envDict: Record<string, string>): string {
  const { resolved, unresolved } = resolveEnvVars(value, envDict);
  if (unresolved.length > 0) {
    console.log(pc.yellow(`  Unresolved: ${unresolved.join(", ")}`));
  }
  return resolved;
}

async function testConnectionFields(
  config: PgdevConfig,
  fields: ConnectionFields,
): Promise<{ success: boolean; error?: string; cmd: string[] }> {
  if (!fields.database) {
    return { success: false, error: "No database specified", cmd: [] };
  }

  const psqlParts = splitCommand(config.tools.psql);
  const cmd = [
    ...psqlParts,
    "-h", fields.host || "localhost",
    "-p", fields.port || "5432",
    "-d", fields.database,
    "-U", fields.username,
    "-c", "SELECT 1",
  ];

  try {
    const proc = Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PGPASSWORD: fields.password },
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) return { success: true, cmd };
    const stderr = await new Response(proc.stderr).text();
    return { success: false, error: stderr.trim(), cmd };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), cmd };
  }
}


// --- Editing: Top Level Config ---

async function editTopLevelConfig(
  configData: Record<string, unknown>,
  header: string,
  filePath: string,
  config: PgdevConfig,
): Promise<void> {
  const schema = await fetchConfigSchema(config);
  const schemaProps = getSchemaTopLevel(schema);
  const settingNames = Object.keys(schemaProps);

  if (settingNames.length === 0) {
    console.log(pc.dim("  Could not load config schema from npgsqlrest"));
    return;
  }

  while (true) {
    const options = settingNames.map((name) => {
      const prop = schemaProps[name];
      const value = configData[name] ?? prop.default;
      const display = value === null || value === undefined ? "(not set)" : String(value);
      return { label: name, description: display, help: DESCRIPTIONS[name] };
    });

    const choice = await ask("Top Level Config", options);
    if (choice === -1) break;

    const name = settingNames[choice];
    const prop = schemaProps[name];

    if (prop.enum) {
      const enumChoice = await ask(name, prop.enum.map((v) => ({
        label: v,
        description: v === String(prop.default) ? "(default)" : "",
      })));
      if (enumChoice === -1) continue;
      configData[name] = prop.enum[enumChoice];
      console.log(success(`${name} = ${prop.enum[enumChoice]}`));
    } else if (isSchemaBoolean(prop)) {
      const current = configData[name] ?? prop.default;
      configData[name] = !current;
      console.log(success(`${name} = ${!current}`));
    } else {
      const current = (configData[name] as string) ?? "";
      const value = askValue(name, current);
      if (value) {
        configData[name] = value;
      } else {
        delete configData[name];
      }
      console.log(success(`${name} = ${value || "(not set)"}`));
    }

    await writeJsonConfig(filePath, configData, header, DESCRIPTIONS);
    console.log(info(`Saved ${filePath}`));
  }
}

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
    console.log(success(`${name} = ${prop.enum[enumChoice]}`));
  } else if (isSchemaBoolean(prop)) {
    const current = container[name] ?? prop.default;
    container[name] = !current;
    console.log(success(`${name} = ${!current}`));
  } else {
    const current = (container[name] as string) ?? "";
    const value = askValue(name, current);
    if (value) {
      container[name] = value;
    } else {
      delete container[name];
    }
    console.log(success(`${name} = ${value || "(not set)"}`));
  }
  return true;
}

async function editConnectionFields(
  configData: Record<string, unknown>,
  header: string,
  filePath: string,
  config: PgdevConfig,
  connName: string,
  isNew: boolean,
): Promise<void> {
  const connStrings = (configData.ConnectionStrings ?? {}) as Record<string, string>;
  const parsed = parseConnectionString(connStrings[connName] ?? "");

  const ENV_DEFAULTS: Record<string, string> = {
    Host: "{PGHOST}", Port: "{PGPORT}", Database: "{PGDATABASE}",
    Username: "{PGUSER}", Password: "{PGPASSWORD}",
  };
  for (const field of CONN_FIELD_ORDER) {
    if (!(field in parsed)) parsed[field] = isNew ? (ENV_DEFAULTS[field] ?? "") : "";
  }

  console.log();
  console.log(`  ${pc.bold(`Editing "${connName}"`)}`);
  if (isNew) {
    console.log(pc.dim(`  Defaults use {ENV_VAR} placeholders — resolved at runtime when ParseEnvironmentVariables is enabled.`));
  }
  console.log();

  for (const field of CONN_FIELD_ORDER) {
    parsed[field] = askValue(field, parsed[field], { mask: field === "Password" });
  }

  const extraFields = Object.keys(parsed).filter((k) => !CONN_FIELD_ORDER.includes(k));
  for (const field of extraFields) {
    parsed[field] = askValue(field, parsed[field]);
  }

  connStrings[connName] = serializeConnectionString(parsed);
  configData.ConnectionStrings = connStrings;

  console.log();
  if (askConfirm("Save changes?", true)) {
    await writeJsonConfig(filePath, configData, header, DESCRIPTIONS);
    console.log(success(`Saved ${filePath}`));
  }

  if (askConfirm("Validate?")) {
    console.log();
    const result = await validateNpgsqlRest(config, filePath);
    console.log(formatValidateResult(result, config.verbose));
  }
}

function buildNpgsqlRestDashboardSections(
  configData: Record<string, unknown>,
  topLevelProps: Record<string, SchemaProperty>,
  configProps: Record<string, SchemaProperty>,
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
        return { key: name, label: name, value: display, help: DESCRIPTIONS[name] };
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
        return { key: `Config.${name}`, label: name, value: display, help: DESCRIPTIONS[`Config.${name}`] };
      }),
    });
  }

  // Connection Strings
  const connStrings = (configData.ConnectionStrings ?? {}) as Record<string, string>;
  const connItems = Object.keys(connStrings).map((name) => ({
    key: `ConnectionStrings.${name}`,
    label: name,
    value: maskConnectionString(connStrings[name]),
    help: DESCRIPTIONS["ConnectionStrings"],
  }));
  connItems.push({
    key: "ConnectionStrings.+new",
    label: "+ Add new",
    value: "",
    help: "Add a new named connection string",
  });
  sections.push({ title: "Connection Strings", items: connItems });

  return sections;
}

// --- NpgsqlRest config dashboard ---

async function editNpgsqlRestDashboard(config: PgdevConfig): Promise<void> {
  const files = discoverConfigFiles(config);
  const existing: ConfigFileRef[] = [];
  for (const f of files) {
    const fullPath = resolve(process.cwd(), f.path);
    if (await Bun.file(fullPath).exists()) existing.push(f);
  }

  if (existing.length === 0) {
    console.log(pc.yellow("  No config files found. Let's create them."));
    console.log();
    await initNpgsqlRest();

    // Reload and re-discover after init
    const reloadedConfig = await loadConfig();
    const newFiles = discoverConfigFiles(reloadedConfig);
    for (const f of newFiles) {
      const fp = resolve(process.cwd(), f.path);
      if (await Bun.file(fp).exists()) existing.push(f);
    }
    if (existing.length === 0) return;
  }

  let chosenFile = existing.find((f) => !f.optional) ?? existing[0];
  let fullPath = resolve(process.cwd(), chosenFile.path);
  let result = await readJsonConfig(fullPath);

  if (!result) {
    console.error(error(`Failed to read ${chosenFile.path}`));
    return;
  }

  const schema = await fetchConfigSchema(config);
  const topLevelProps = getSchemaTopLevel(schema);
  const configProps = getSchemaSection(schema, "Config");

  let lastSelected: string | undefined;
  let lastStatus: string | undefined;

  while (true) {
    const sections = buildNpgsqlRestDashboardSections(result.data, topLevelProps, configProps);

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
          chosenFile = existing[fileChoice];
          fullPath = resolve(process.cwd(), chosenFile.path);
          const reloaded = await readJsonConfig(fullPath);
          if (!reloaded) {
            console.error(error(`Failed to read ${chosenFile.path}`));
            break;
          }
          result = reloaded;
        }
        lastSelected = undefined;
      } else if (choice.key === "t") {
        const validateResult = await validateNpgsqlRest(config, fullPath);
        lastStatus = formatValidateResult(validateResult, config.verbose);
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
          console.log(pc.yellow(`  "${newName}" already exists. Select it from the dashboard.`));
          continue;
        }
        connStrings[newName] = "";
        result.data.ConnectionStrings = connStrings;
        await editConnectionFields(result.data, result.header, fullPath, config, newName, true);
        lastSelected = `ConnectionStrings.${newName}`;
      } else {
        await editConnectionFields(result.data, result.header, fullPath, config, connName, false);
      }
    } else if (choice.key.startsWith("Config.")) {
      const name = choice.key.slice("Config.".length);
      const prop = configProps[name];
      if (prop) {
        const configSection = (result.data.Config ?? {}) as Record<string, unknown>;
        if (await editSchemaItem(configSection, name, prop)) {
          result.data.Config = configSection;
          await writeJsonConfig(fullPath, result.data, result.header, DESCRIPTIONS);
          console.log(info(`Saved ${chosenFile.path}`));
        }
      }
    } else {
      // Top-level setting
      const prop = topLevelProps[choice.key];
      if (prop) {
        if (await editSchemaItem(result.data, choice.key, prop)) {
          await writeJsonConfig(fullPath, result.data, result.header, DESCRIPTIONS);
          console.log(info(`Saved ${chosenFile.path}`));
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
      lines.push(pc.dim(formatCmd(connResult.cmd)));
    }
    if (connResult.success) {
      lines.push(success(`Connection: OK (shared "${connName}" from ${configFile})`));
    } else {
      lines.push(error(`Connection: ${connResult.error}`));
    }
    return lines.join("\n");
  } else {
    const conn = config.connection;
    if (!conn.database && !conn.host) {
      return pc.yellow("No connection configured.");
    }

    const envDict = await buildPgdevEnvDict(config.env_file);
    const connResult = await testConnectionFields(config, {
      host: resolveConnectionField(conn.host ?? "", envDict),
      port: resolveConnectionField(conn.port ?? "", envDict),
      database: resolveConnectionField(conn.database ?? "", envDict),
      username: resolveConnectionField(conn.username ?? "", envDict),
      password: resolveConnectionField(conn.password ?? "", envDict),
    });
    const lines: string[] = [];
    if (config.verbose && connResult.cmd.length > 0) {
      lines.push(pc.dim(formatCmd(connResult.cmd)));
    }
    if (connResult.success) {
      lines.push(success("Connection: OK"));
    } else {
      lines.push(error(`Connection: ${connResult.error}`));
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

  return sections;
}

async function pickSharedConfigFile(config: PgdevConfig): Promise<void> {
  const files = discoverConfigFiles(config);
  const existing: ConfigFileRef[] = [];
  for (const f of files) {
    const fullPath = resolve(process.cwd(), f.path);
    if (await Bun.file(fullPath).exists()) existing.push(f);
  }

  if (existing.length === 0) {
    console.log(pc.yellow("  No config files found in pgdev.toml commands."));
    console.log(pc.dim(`  Use the ${pc.bold("NpgsqlRest config")} option to create them.`));
    return;
  }

  const fileChoice = await ask(
    "Which config file?",
    existing.map((f) => ({ label: f.path, description: f.optional ? "(optional)" : "" })),
  );
  if (fileChoice === -1) return;

  await updateConfig("connection", "config_file", existing[fileChoice].path);
  console.log(info(`Config updated: connection.config_file = "${existing[fileChoice].path}"`));
}

async function pickConnectionName(config: PgdevConfig): Promise<void> {
  const configFile = config.connection.config_file;
  if (!configFile) {
    console.log(pc.yellow("  Set config file first."));
    return;
  }

  const fullPath = resolve(process.cwd(), configFile);
  const result = await readJsonConfig(fullPath);
  if (!result) {
    console.error(error(`Failed to read ${configFile}`));
    return;
  }

  const connStrings = (result.data.ConnectionStrings ?? {}) as Record<string, string>;
  const connNames = Object.keys(connStrings);

  if (connNames.length === 0) {
    console.log(pc.yellow("  No connection strings found in this config file."));
    console.log(pc.dim(`  Use ${pc.bold("pgdev config")} → NpgsqlRest config to add one.`));
    return;
  }

  if (connNames.length === 1) {
    await updateConfig("connection", "connection_name", connNames[0]);
    console.log(info(`Config updated: connection.connection_name = "${connNames[0]}"`));
    return;
  }

  const connChoice = await ask(
    "Which connection?",
    connNames.map((name) => ({
      label: name,
      description: maskConnectionString(connStrings[name]),
    })),
  );
  if (connChoice === -1) return;

  await updateConfig("connection", "connection_name", connNames[connChoice]);
  console.log(info(`Config updated: connection.connection_name = "${connNames[connChoice]}"`));
}

async function editPgdevEnvironment(config: PgdevConfig): Promise<void> {
  let currentConfig = config;
  let lastSelected: string | undefined;
  let lastStatus: string | undefined;

  while (true) {
    const sections = buildPgdevEnvironmentDashboard(currentConfig);
    const actions = [
      { key: "t", label: "Test connection" },
      { key: "q", label: "Back" },
    ];

    const choice = await askDashboard("pgdev environment", sections, actions, { selected: lastSelected, status: lastStatus });

    if (choice === null || (choice.type === "action" && choice.key === "q")) {
      break;
    }

    if (choice.type === "action" && choice.key === "t") {
      lastStatus = await testPgdevConnection(currentConfig);
      lastSelected = undefined;
      currentConfig = await loadConfig();
      continue;
    }

    if (choice.type === "item") {
      lastSelected = choice.key;
      lastStatus = undefined;

      if (choice.key === "env_file") {
        const current = currentConfig.env_file ?? "";
        const value = askValue("Env file", current, { path: true });
        if (value !== current) {
          if (value) {
            await updateConfig("", "env_file", value);
            console.log(info(`Config updated: env_file = "${value}"`));
          } else {
            await updateConfig("", "env_file", "");
            console.log(info("Config updated: env_file cleared"));
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
          await pickSharedConfigFile(currentConfig);
        } else if (modeChoice === 1 && currentlyShared) {
          // Switch to independent: remove config_file and connection_name
          await removeConfigKey("connection", "config_file");
          await removeConfigKey("connection", "connection_name");
          console.log(info("Switched to independent connection mode"));
        }
      } else if (choice.key === "conn_config_file") {
        await pickSharedConfigFile(currentConfig);
      } else if (choice.key === "conn_name") {
        await pickConnectionName(currentConfig);
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
          if (value !== current) {
            await updateConfig("connection", field, value);
            console.log(info(`Config updated: connection.${field} = "${field === "password" ? "****" : value}"`));
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
): Promise<void> {
  const current = config.project[key];
  const dir = askPath(label, current);

  if (dir === current) return;

  if (!dir) {
    await updateConfig("project", key, "");
    console.log(info(`Config updated: project.${key} cleared`));
    return;
  }

  const err = validateProjectDir(dir, key, config);
  if (err) {
    console.log(pc.yellow(`  ${err}`));
    return;
  }

  // Create directory if it doesn't exist
  const abs = resolve(process.cwd(), dir);
  try {
    statSync(abs);
  } catch {
    mkdirSync(abs, { recursive: true });
    console.log(success(`Created ${dir}`));
  }

  await updateConfig("project", key, dir);
  console.log(info(`Config updated: project.${key} = "${dir}"`));
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

async function handleSchemas(config: PgdevConfig): Promise<void> {
  const result = await runPsqlQuery(config, config.commands.schemas_query);
  if (!result.ok) {
    console.log(error(`Failed to query schemas: ${result.error}`));
    return;
  }

  if (result.rows.length === 0) {
    console.log(pc.yellow("  No non-system schemas found in database."));
    return;
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

    const choice = await askDashboard("Project settings", sections, actions, { selected: lastSelected });

    if (choice === null || (choice.type === "action" && choice.key === "q")) break;

    if (choice.type === "item") {
      lastSelected = choice.key;
      const key = choice.key as "routines_dir" | "migrations_dir" | "tests_dir";
      const labels: Record<string, string> = {
        routines_dir: "Routines directory",
        migrations_dir: "Migrations directory",
        tests_dir: "Tests directory",
      };
      await handleProjectDir(key, labels[key], currentConfig);
      currentConfig = await loadConfig();
    }
  }
}

// --- Main entry ---

export async function configCommand(config: PgdevConfig): Promise<void> {
  let currentConfig = config;
  let lastSelected: string | undefined;

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
        ],
      },
    ];
    const actions = [{ key: "q", label: "Quit" }];

    const choice = await askDashboard("pgdev config", sections, actions, { selected: lastSelected });

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
        await handleSchemas(currentConfig);
      }

      currentConfig = await loadConfig();
    }
  }
}
