import { $ } from "bun";
import { resolve } from "node:path";
import { loadConfig, type PgdevConfig, updateConfig, removeConfigKey, isSharedConnection } from "../config.ts";
import { success, error, info, pc } from "../utils/terminal.ts";
import { ask, askConfirm, askValue, askDashboard } from "../utils/prompt.ts";
import { readJsonConfig, writeJsonConfig } from "../utils/json.ts";
import { splitCommand } from "../cli.ts";
import { resolveEnvVars, loadEnvFile, buildPgdevEnvDict } from "../utils/env.ts";

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

// --- NpgsqlRest env dict (reads from NpgsqlRest config data) ---

async function buildNpgsqlRestEnvDict(configData: Record<string, unknown>): Promise<Record<string, string>> {
  const configSection = (configData.Config ?? {}) as Record<string, unknown>;
  const parseEnv = configSection.ParseEnvironmentVariables !== false; // default true

  if (!parseEnv) return {};

  const envDict: Record<string, string> = {};

  // System environment
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) envDict[key] = value;
  }

  // Env file (overrides system env)
  const envFile = configSection.EnvFile as string | null | undefined;
  if (envFile) {
    const envFilePath = resolve(process.cwd(), envFile);
    const fileVars = await loadEnvFile(envFilePath);
    Object.assign(envDict, fileVars);
  }

  return envDict;
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
): Promise<{ success: boolean; error?: string }> {
  if (!fields.database) {
    return { success: false, error: "No database specified" };
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
    if (exitCode === 0) return { success: true };
    const stderr = await new Response(proc.stderr).text();
    return { success: false, error: stderr.trim() };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function testNpgsqlRestConnectionString(
  config: PgdevConfig,
  connStr: string,
  envDict: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  const { resolved, unresolved } = resolveEnvVars(connStr, envDict);
  if (unresolved.length > 0) {
    console.log(pc.yellow(`  Unresolved variables: ${unresolved.join(", ")}`));
    console.log(pc.dim("  These variables are not set in the environment or env file."));
  }
  const parsed = parseConnectionString(resolved);
  return testConnectionFields(config, {
    host: parsed.Host || "localhost",
    port: parsed.Port || "5432",
    database: parsed.Database || "",
    username: parsed.Username || "",
    password: parsed.Password || "",
  });
}

// --- Editing: Top Level Config ---

export async function editTopLevelConfig(
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

  if (askConfirm("Test connection?")) {
    console.log();
    const envDict = await buildNpgsqlRestEnvDict(configData);
    const connResult = await testNpgsqlRestConnectionString(config, connStrings[connName], envDict);
    if (connResult.success) {
      console.log(success("Connection successful"));
    } else {
      console.log(error(`Connection failed: ${connResult.error}`));
    }
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
    console.error(error("No config files found in pgdev.toml"));
    console.log(pc.dim(`  Run ${pc.bold("pgdev init")} to create config files.`));
    return;
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

  while (true) {
    const sections = buildNpgsqlRestDashboardSections(result.data, topLevelProps, configProps);

    const actions: { key: string; label: string }[] = [];
    if (existing.length > 1) {
      actions.push({ key: "f", label: `Switch file (${chosenFile.path.split("/").pop()})` });
    }
    actions.push({ key: "t", label: "Test connection" });
    actions.push({ key: "q", label: "Back" });

    const choice = await askDashboard(
      `NpgsqlRest config — ${chosenFile.path}`,
      sections,
      actions,
      { selected: lastSelected },
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
        const connStrings = (result.data.ConnectionStrings ?? {}) as Record<string, string>;
        const firstConn = Object.keys(connStrings)[0];
        if (!firstConn) {
          console.log(pc.yellow("  No connection strings configured."));
        } else {
          console.log(info(`Testing connection "${firstConn}"...`));
          const envDict = await buildNpgsqlRestEnvDict(result.data);
          const connResult = await testNpgsqlRestConnectionString(config, connStrings[firstConn], envDict);
          if (connResult.success) {
            console.log(success("Connection successful"));
          } else {
            console.log(error(`Connection failed: ${connResult.error}`));
          }
        }
        lastSelected = undefined;
      }
      continue;
    }

    // Item selected
    lastSelected = choice.key;

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

async function testPgdevConnection(config: PgdevConfig): Promise<void> {
  if (isSharedConnection(config.connection)) {
    const configFile = config.connection.config_file;
    const connName = config.connection.connection_name ?? "Default";

    if (!configFile) {
      console.log(pc.yellow("  No config file set."));
      return;
    }

    const fullPath = resolve(process.cwd(), configFile);
    const result = await readJsonConfig(fullPath);
    if (!result) {
      console.error(error(`Failed to read ${configFile}`));
      return;
    }

    const connStrings = (result.data.ConnectionStrings ?? {}) as Record<string, string>;
    const connStr = connStrings[connName];
    if (!connStr) {
      console.error(error(`Connection "${connName}" not found in ${configFile}`));
      return;
    }

    const envDict = await buildNpgsqlRestEnvDict(result.data);
    console.log(info(`Testing shared connection "${connName}" from ${configFile}`));
    const connResult = await testNpgsqlRestConnectionString(config, connStr, envDict);
    if (connResult.success) {
      console.log(success("Connection successful"));
    } else {
      console.log(error(`Connection failed: ${connResult.error}`));
    }
  } else {
    const conn = config.connection;
    if (!conn.database && !conn.host) {
      console.log(pc.yellow("  No connection configured."));
      return;
    }

    const envDict = await buildPgdevEnvDict(config.env_file);
    console.log(info("Testing independent connection"));
    const connResult = await testConnectionFields(config, {
      host: resolveConnectionField(conn.host ?? "", envDict),
      port: resolveConnectionField(conn.port ?? "", envDict),
      database: resolveConnectionField(conn.database ?? "", envDict),
      username: resolveConnectionField(conn.username ?? "", envDict),
      password: resolveConnectionField(conn.password ?? "", envDict),
    });
    if (connResult.success) {
      console.log(success("Connection successful"));
    } else {
      console.log(error(`Connection failed: ${connResult.error}`));
    }
  }
}

// --- pgdev environment status ---

export function environmentStatus(config: PgdevConfig): string {
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
    console.log(pc.dim(`  Run ${pc.bold("pgdev init")} → NpgsqlRest config to create them.`));
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

export async function editPgdevEnvironment(config: PgdevConfig): Promise<void> {
  let currentConfig = config;
  let lastSelected: string | undefined;

  while (true) {
    const sections = buildPgdevEnvironmentDashboard(currentConfig);
    const actions = [
      { key: "t", label: "Test connection" },
      { key: "q", label: "Back" },
    ];

    const choice = await askDashboard("pgdev environment", sections, actions, { selected: lastSelected });

    if (choice === null || (choice.type === "action" && choice.key === "q")) {
      break;
    }

    if (choice.type === "action" && choice.key === "t") {
      await testPgdevConnection(currentConfig);
      lastSelected = undefined;
      currentConfig = await loadConfig();
      continue;
    }

    if (choice.type === "item") {
      lastSelected = choice.key;

      if (choice.key === "env_file") {
        const current = currentConfig.env_file ?? "";
        const value = askValue("Env file", current);
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

// --- Main entry ---

export async function configCommand(config: PgdevConfig): Promise<void> {
  while (true) {
    const sections = [
      {
        title: "",
        items: [
          {
            key: "npgsqlrest",
            label: "NpgsqlRest config",
            value: "Edit NpgsqlRest JSON config files",
          },
          {
            key: "environment",
            label: "pgdev environment",
            value: "Env file, database connection",
          },
        ],
      },
    ];
    const actions = [{ key: "q", label: "Quit" }];

    const choice = await askDashboard("pgdev config", sections, actions);

    if (choice === null || (choice.type === "action" && choice.key === "q")) return;

    if (choice.type === "item") {
      if (choice.key === "npgsqlrest") {
        await editNpgsqlRestDashboard(config);
      } else if (choice.key === "environment") {
        await editPgdevEnvironment(config);
      }
    }
  }
}
