import { $ } from "bun";
import { resolve } from "node:path";
import { type PgdevConfig, updateConfig } from "../config.ts";
import { success, error, info, pc } from "../utils/terminal.ts";
import { ask, askConfirm, askValue } from "../utils/prompt.ts";
import { readJsonConfig, writeJsonConfig } from "../utils/json.ts";
import { splitCommand } from "../cli.ts";

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

// --- Env var resolution ---

function resolveEnvVars(
  value: string,
  envDict: Record<string, string>,
): { resolved: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const resolved = value.replace(/\{([^}]+)\}/g, (_match, varName: string) => {
    if (varName in envDict) return envDict[varName];
    unresolved.push(varName);
    return `{${varName}}`;
  });
  return { resolved, unresolved };
}

async function loadEnvFile(path: string): Promise<Record<string, string>> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};

  const vars: Record<string, string> = {};
  const text = await file.text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

async function buildEnvDict(configData: Record<string, unknown>): Promise<Record<string, string>> {
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

async function testConnection(
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
  const host = parsed.Host || "localhost";
  const port = parsed.Port || "5432";
  const database = parsed.Database || "";
  const username = parsed.Username || "";
  const password = parsed.Password || "";

  if (!database) {
    return { success: false, error: "No database specified in connection string" };
  }

  const psqlParts = splitCommand(config.tools.psql);
  const cmd = [...psqlParts, "-h", host, "-p", port, "-d", database, "-U", username, "-c", "SELECT 1"];

  try {
    const proc = Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PGPASSWORD: password },
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) return { success: true };
    const stderr = await new Response(proc.stderr).text();
    return { success: false, error: stderr.trim() };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
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

// --- Editing: Connection Strings ---

async function editConnectionStrings(
  configData: Record<string, unknown>,
  header: string,
  filePath: string,
  config: PgdevConfig,
): Promise<void> {
  const connStrings = (configData.ConnectionStrings ?? {}) as Record<string, string>;
  const envDict = await buildEnvDict(configData);

  while (true) {
    const names = Object.keys(connStrings);
    const options = names.map((name) => ({
      label: name,
      description: maskConnectionString(connStrings[name]),
    }));
    options.push({ label: "Add new connection", description: "" });

    const choice = await ask("Connection Strings", options);
    if (choice === -1) break;

    if (choice === names.length) {
      // Add new connection
      const nameInput = prompt(`  ${pc.bold("Connection name")} ${pc.dim("[Default]")}>`);
      const connName = (nameInput ?? "").trim() || "Default";
      if (connName in connStrings) {
        console.log(pc.yellow(`  Connection "${connName}" already exists. Select it to edit.`));
        continue;
      }
      connStrings[connName] = "";
      configData.ConnectionStrings = connStrings;
    }

    const isNew = choice >= names.length;
    const connName = isNew ? Object.keys(connStrings).at(-1)! : names[choice];
    const parsed = parseConnectionString(connStrings[connName]);

    // Ensure default fields exist — new connections default to env var placeholders
    const ENV_DEFAULTS: Record<string, string> = {
      Host: "{PGHOST}",
      Port: "{PGPORT}",
      Database: "{PGDATABASE}",
      Username: "{PGUSER}",
      Password: "{PGPASSWORD}",
    };
    for (const field of CONN_FIELD_ORDER) {
      if (!(field in parsed)) parsed[field] = isNew ? (ENV_DEFAULTS[field] ?? "") : "";
    }

    console.log();
    console.log(`  ${pc.bold(`Editing connection "${connName}"`)}`);
    if (isNew) {
      console.log(pc.dim(`  Defaults use {ENV_VAR} placeholders — resolved at runtime when ParseEnvironmentVariables is enabled.`));
    }
    console.log();

    for (const field of CONN_FIELD_ORDER) {
      parsed[field] = askValue(field, parsed[field], { mask: field === "Password" });
    }

    // Show extra fields if any
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
      const result = await testConnection(config, connStrings[connName], envDict);
      if (result.success) {
        console.log(success("Connection successful"));
      } else {
        console.log(error(`Connection failed: ${result.error}`));
      }
    }
  }
}

// --- Editing: Config Settings ---

async function editConfigSettings(
  configData: Record<string, unknown>,
  header: string,
  filePath: string,
  config: PgdevConfig,
): Promise<void> {
  const configSection = (configData.Config ?? {}) as Record<string, unknown>;

  // Fetch settings schema from npgsqlrest
  const schema = await fetchConfigSchema(config);
  const schemaProps = getSchemaSection(schema, "Config");
  const settingNames = Object.keys(schemaProps);

  if (settingNames.length === 0) {
    console.log(pc.dim("  Could not load config schema from npgsqlrest"));
    return;
  }

  while (true) {
    const options = settingNames.map((name) => {
      const prop = schemaProps[name];
      const value = configSection[name] ?? prop.default;
      const display = value === null || value === undefined ? "(not set)" : String(value);
      return { label: name, description: display, help: DESCRIPTIONS[`Config.${name}`] };
    });

    const choice = await ask("Config Settings", options);
    if (choice === -1) break;

    const name = settingNames[choice];
    const prop = schemaProps[name];

    if (prop.enum) {
      const enumChoice = await ask(name, prop.enum.map((v) => ({
        label: v,
        description: v === String(prop.default) ? "(default)" : "",
      })));
      if (enumChoice === -1) continue;
      configSection[name] = prop.enum[enumChoice];
      console.log(success(`${name} = ${prop.enum[enumChoice]}`));
    } else if (isSchemaBoolean(prop)) {
      const current = configSection[name] ?? prop.default;
      configSection[name] = !current;
      console.log(success(`${name} = ${!current}`));
    } else {
      const current = (configSection[name] as string) ?? "";
      const value = askValue(name, current);
      if (value) {
        configSection[name] = value;
      } else {
        delete configSection[name];
      }
      console.log(success(`${name} = ${value || "(not set)"}`));
    }

    configData.Config = configSection;
    await writeJsonConfig(filePath, configData, header, DESCRIPTIONS);
    console.log(info(`Saved ${filePath}`));
  }
}

// --- NpgsqlRest config editing ---

async function editNpgsqlRestConfig(config: PgdevConfig): Promise<void> {
  const files = discoverConfigFiles(config);

  if (files.length === 0) {
    console.error(error("No config files found in pgdev.toml commands"));
    console.log(pc.dim(`  Run ${pc.bold("pgdev init")} to create config files.`));
    return;
  }

  // Check which files actually exist
  const existing: ConfigFileRef[] = [];
  for (const f of files) {
    const fullPath = resolve(process.cwd(), f.path);
    if (await Bun.file(fullPath).exists()) {
      existing.push(f);
    }
  }

  if (existing.length === 0) {
    console.error(error("None of the config files from pgdev.toml exist on disk"));
    console.log(pc.dim(`  Run ${pc.bold("pgdev init")} to create config files.`));
    return;
  }

  const fileChoice = await ask(
    "Which config file?",
    existing.map((f) => ({
      label: f.path,
      description: f.optional ? "(optional)" : "",
    })),
  );
  if (fileChoice === -1) return;

  const chosen = existing[fileChoice];
  const fullPath = resolve(process.cwd(), chosen.path);
  const result = await readJsonConfig(fullPath);

  if (!result) {
    console.error(error(`Failed to read ${chosen.path}`));
    return;
  }

  while (true) {
    const section = await ask("Config section?", [
      { label: "Top Level Config", description: "ApplicationName, Urls, EnvironmentName, StartupMessage" },
      { label: "Connection Strings", description: "Edit database connection strings" },
      { label: "Config Settings", description: "ParseEnvironmentVariables, EnvFile, etc." },
    ]);

    if (section === -1) break;

    if (section === 0) {
      await editTopLevelConfig(result.data, result.header, fullPath, config);
    } else if (section === 1) {
      await editConnectionStrings(result.data, result.header, fullPath, config);
    } else {
      await editConfigSettings(result.data, result.header, fullPath, config);
    }
  }
}

// --- pgdev connection configuration ---

export async function configurePgdevConnection(config: PgdevConfig): Promise<void> {
  const choice = await ask("pgdev Database Connection", [
    { label: "Share with NpgsqlRest", description: "Read connection from a config file" },
    { label: "Independent connection", description: "Own connection string in pgdev.toml" },
    { label: "Test current connection", description: "" },
  ]);

  if (choice === -1) return;

  if (choice === 0) {
    // Shared connection
    const files = discoverConfigFiles(config);
    const existing: ConfigFileRef[] = [];
    for (const f of files) {
      const fullPath = resolve(process.cwd(), f.path);
      if (await Bun.file(fullPath).exists()) existing.push(f);
    }

    if (existing.length === 0) {
      console.error(error("No config files found"));
      return;
    }

    const fileChoice = await ask(
      "Which config file?",
      existing.map((f) => ({ label: f.path, description: f.optional ? "(optional)" : "" })),
    );
    if (fileChoice === -1) return;

    const chosenFile = existing[fileChoice];
    const fullPath = resolve(process.cwd(), chosenFile.path);
    const result = await readJsonConfig(fullPath);

    if (!result) {
      console.error(error(`Failed to read ${chosenFile.path}`));
      return;
    }

    const connStrings = (result.data.ConnectionStrings ?? {}) as Record<string, string>;
    const connNames = Object.keys(connStrings);

    if (connNames.length === 0) {
      console.log(pc.yellow("  No connection strings found in this config file."));
      console.log(pc.dim(`  Use ${pc.bold("pgdev config")} → NpgsqlRest config to add one.`));
      return;
    }

    let connName: string;
    if (connNames.length === 1) {
      connName = connNames[0];
    } else {
      const connChoice = await ask(
        "Which connection?",
        connNames.map((name) => ({
          label: name,
          description: maskConnectionString(connStrings[name]),
        })),
      );
      if (connChoice === -1) return;
      connName = connNames[connChoice];
    }

    await updateConfig("connection", "mode", "shared");
    await updateConfig("connection", "config_file", chosenFile.path);
    await updateConfig("connection", "connection_name", connName);

    console.log();
    console.log(success("pgdev connection configured (shared)"));
    console.log(info(`Config file: ${chosenFile.path}`));
    console.log(info(`Connection: ${connName}`));

    if (askConfirm("Test connection?")) {
      const envDict = await buildEnvDict(result.data);
      const connResult = await testConnection(config, connStrings[connName], envDict);
      if (connResult.success) {
        console.log(success("Connection successful"));
      } else {
        console.log(error(`Connection failed: ${connResult.error}`));
      }
    }
  } else if (choice === 1) {
    // Independent connection
    console.log();
    console.log(`  ${pc.bold("pgdev Database Connection (independent)")}`);
    console.log();

    const existing = parseConnectionString(config.connection.connection_string ?? "");
    const parsed: ParsedConnectionString = {};
    for (const field of CONN_FIELD_ORDER) {
      parsed[field] = askValue(field, existing[field] ?? (field === "Port" ? "5432" : ""));
    }

    const connStr = serializeConnectionString(parsed);
    await updateConfig("connection", "mode", "independent");
    await updateConfig("connection", "connection_string", connStr);

    console.log();
    console.log(success("pgdev connection configured (independent)"));

    if (askConfirm("Test connection?")) {
      const envDict: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) envDict[key] = value;
      }
      const connResult = await testConnection(config, connStr, envDict);
      if (connResult.success) {
        console.log(success("Connection successful"));
      } else {
        console.log(error(`Connection failed: ${connResult.error}`));
      }
    }
  } else if (choice === 2) {
    // Test current connection
    let connStr: string | undefined;
    let envDict: Record<string, string> = {};

    if (config.connection.mode === "shared") {
      const configFile = config.connection.config_file;
      const connName = config.connection.connection_name ?? "Default";

      if (!configFile) {
        console.log(pc.yellow("  No config file set. Run pgdev config to set up."));
        return;
      }

      const fullPath = resolve(process.cwd(), configFile);
      const result = await readJsonConfig(fullPath);
      if (!result) {
        console.error(error(`Failed to read ${configFile}`));
        return;
      }

      const connStrings = (result.data.ConnectionStrings ?? {}) as Record<string, string>;
      connStr = connStrings[connName];
      if (!connStr) {
        console.error(error(`Connection "${connName}" not found in ${configFile}`));
        return;
      }

      envDict = await buildEnvDict(result.data);
      console.log(info(`Testing shared connection "${connName}" from ${configFile}`));
    } else {
      connStr = config.connection.connection_string;
      if (!connStr) {
        console.log(pc.yellow("  No connection string configured. Run pgdev config to set up."));
        return;
      }

      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) envDict[key] = value;
      }
      console.log(info("Testing independent connection"));
    }

    const result = await testConnection(config, connStr, envDict);
    if (result.success) {
      console.log(success("Connection successful"));
    } else {
      console.log(error(`Connection failed: ${result.error}`));
    }
  }
}

// --- Main entry ---

export async function configCommand(config: PgdevConfig): Promise<void> {
  while (true) {
    const choice = await ask("What would you like to configure?", [
      { label: "NpgsqlRest config", description: "Edit connection strings and settings in JSON config files" },
      { label: "pgdev connection", description: "Configure pgdev's own database connection" },
    ], { exit: true });

    if (choice === -1) return;

    if (choice === 0) {
      await editNpgsqlRestConfig(config);
    } else {
      await configurePgdevConnection(config);
    }
  }
}
