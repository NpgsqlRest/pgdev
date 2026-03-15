import { readFileSync, writeFileSync } from "node:fs";
import { success, error, pc } from "./utils/terminal.ts";

export interface NpgsqlRestConfig {
  commands: Record<string, string>;
}

export interface ConnectionConfig {
  config_file?: string;
  connection_name?: string;
  host?: string;
  port?: string;
  database?: string;
  username?: string;
  password?: string;
}

export function isSharedConnection(conn: ConnectionConfig): boolean {
  return !!conn.config_file;
}

export interface CommandsConfig {
  schemas_query: string;
}

export type GroupDimension = "type" | "schema" | "name" | "kind";

export interface ProjectConfig {
  routines_dir: string;
  migrations_dir: string;
  tests_dir: string;
  schemas: string[];
  grants: boolean;
  ignore_body_whitespace: boolean;
  /** Object types to extract into individual files (excluded from schema.sql) */
  routine_types: string[];
  api_dir: string;
  internal_dir: string;
  group_segment: number;
  skip_prefixes: string[];
  /** Directory nesting order. Available: "type", "schema", "name", "kind" */
  group_order: GroupDimension[];
  /** Files to skip during sync (relative paths, set via "Never" in interactive mode) */
  sync_skip: string[];
}

export interface FormatConfig {
  lowercase: boolean;
  param_style: "inline" | "multiline";
  indent: string;
  simplify_defaults: boolean;
  omit_default_direction: boolean;
  attribute_style: "inline" | "multiline";
  strip_dump_comments: boolean;
  comment_signature_style: "types_only" | "full";
  drop_before_create: boolean;
  create_or_replace: boolean;
}

export interface PgdevConfig {
  env_file?: string;
  tools: {
    npgsqlrest: string;
    psql: string;
    pg_dump: string;
    pg_restore: string;
  };
  npgsqlrest: NpgsqlRestConfig;
  commands: CommandsConfig;
  connection: ConnectionConfig;
  project: ProjectConfig;
  format: FormatConfig;
  verbose: boolean;
}

const defaults: PgdevConfig = {
  tools: {
    npgsqlrest: "npgsqlrest",
    psql: "psql",
    pg_dump: "pg_dump",
    pg_restore: "pg_restore",
  },
  npgsqlrest: {
    commands: {},
  },
  commands: {
    schemas_query: `select nspname::text from pg_namespace where nspname not like 'pg_%' and left(nspname, 1) <> '_' and nspname <> 'information_schema' order by nspname`,
  },
  connection: {
    connection_name: "Default",
  },
  project: {
    routines_dir: "",
    migrations_dir: "",
    tests_dir: "",
    schemas: [],
    grants: false,
    ignore_body_whitespace: false,
    routine_types: ["FUNCTION", "PROCEDURE"],
    api_dir: "",
    internal_dir: "",
    group_segment: 0,
    skip_prefixes: [],
    group_order: [],
    sync_skip: [],
  },
  format: {
    lowercase: true,
    param_style: "multiline",
    indent: "    ",
    simplify_defaults: true,
    omit_default_direction: true,
    attribute_style: "multiline",
    strip_dump_comments: true,
    comment_signature_style: "types_only",
    drop_before_create: true,
    create_or_replace: false,
  },
  verbose: true,
};

async function readToml(path: string): Promise<Record<string, unknown> | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const text = await file.text();
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (err) {
    console.error(error(`Failed to parse ${pc.bold(path)}`));
    console.error(pc.dim(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

export async function updateConfig(section: string, key: string, value: string): Promise<void> {
  const path = `${process.cwd()}/pgdev.toml`;
  const file = Bun.file(path);
  let content = (await file.exists()) ? await file.text() : "";

  const newLine = `${key} = "${value}"`;
  const keyPattern = new RegExp(`^${key}\\s*=.*$`, "m");

  if (!section) {
    // Top-level key (no section header)
    // Find top-level region: everything before the first [section] header
    const firstSectionMatch = content.match(/^\[/m);
    const topLevelEnd = firstSectionMatch?.index ?? content.length;
    const topLevel = content.slice(0, topLevelEnd);

    if (keyPattern.test(topLevel)) {
      const updated = topLevel.replace(keyPattern, newLine);
      content = updated + content.slice(topLevelEnd);
    } else {
      // Insert at end of top-level region
      const suffix = topLevel.endsWith("\n") || topLevel === "" ? "" : "\n";
      content = topLevel + suffix + newLine + "\n" + content.slice(topLevelEnd);
    }
  } else {
    const sectionHeader = `[${section}]`;
    const sectionIndex = content.indexOf(sectionHeader);
    if (sectionIndex !== -1) {
      // Section exists — find the range of this section
      const afterSection = content.slice(sectionIndex + sectionHeader.length);
      const nextSectionMatch = afterSection.match(/\n\[/);
      const sectionEnd = nextSectionMatch
        ? sectionIndex + sectionHeader.length + nextSectionMatch.index!
        : content.length;
      const sectionContent = content.slice(sectionIndex, sectionEnd);

      if (keyPattern.test(sectionContent)) {
        // Key exists in section — replace it
        const updated = sectionContent.replace(keyPattern, newLine);
        content = content.slice(0, sectionIndex) + updated + content.slice(sectionEnd);
      } else {
        // Key doesn't exist — append after section header
        const insertPos = sectionIndex + sectionHeader.length;
        content = content.slice(0, insertPos) + `\n${newLine}` + content.slice(insertPos);
      }
    } else {
      // Section doesn't exist — append it
      const suffix = content.endsWith("\n") || content === "" ? "" : "\n";
      content += `${suffix}\n${sectionHeader}\n${newLine}\n`;
    }
  }

  await Bun.write(path, content);
}

export async function updateConfigBool(section: string, key: string, value: boolean): Promise<void> {
  const path = `${process.cwd()}/pgdev.toml`;
  const file = Bun.file(path);
  let content = (await file.exists()) ? await file.text() : "";

  const newLine = `${key} = ${value}`;
  const keyPattern = new RegExp(`^${key}\\s*=.*$`, "m");

  if (!section) {
    const firstSectionMatch = content.match(/^\[/m);
    const topLevelEnd = firstSectionMatch?.index ?? content.length;
    const topLevel = content.slice(0, topLevelEnd);

    if (keyPattern.test(topLevel)) {
      content = topLevel.replace(keyPattern, newLine) + content.slice(topLevelEnd);
    } else {
      const suffix = topLevel.endsWith("\n") || topLevel === "" ? "" : "\n";
      content = topLevel + suffix + newLine + "\n" + content.slice(topLevelEnd);
    }
  } else {
    const sectionHeader = `[${section}]`;
    const sectionIndex = content.indexOf(sectionHeader);
    if (sectionIndex !== -1) {
      const afterSection = content.slice(sectionIndex + sectionHeader.length);
      const nextSectionMatch = afterSection.match(/\n\[/);
      const sectionEnd = nextSectionMatch
        ? sectionIndex + sectionHeader.length + nextSectionMatch.index!
        : content.length;
      const sectionContent = content.slice(sectionIndex, sectionEnd);

      if (keyPattern.test(sectionContent)) {
        const updated = sectionContent.replace(keyPattern, newLine);
        content = content.slice(0, sectionIndex) + updated + content.slice(sectionEnd);
      } else {
        const insertPos = sectionIndex + sectionHeader.length;
        content = content.slice(0, insertPos) + `\n${newLine}` + content.slice(insertPos);
      }
    } else {
      const suffix = content.endsWith("\n") || content === "" ? "" : "\n";
      content += `${suffix}\n${sectionHeader}\n${newLine}\n`;
    }
  }

  await Bun.write(path, content);
}

export async function updateConfigInt(section: string, key: string, value: number): Promise<void> {
  // Same logic as updateConfigBool — writes `key = value` without quotes
  const path = `${process.cwd()}/pgdev.toml`;
  const file = Bun.file(path);
  let content = (await file.exists()) ? await file.text() : "";

  const newLine = `${key} = ${value}`;
  const keyPattern = new RegExp(`^${key}\\s*=.*$`, "m");

  if (!section) {
    const firstSectionMatch = content.match(/^\[/m);
    const topLevelEnd = firstSectionMatch?.index ?? content.length;
    const topLevel = content.slice(0, topLevelEnd);

    if (keyPattern.test(topLevel)) {
      content = topLevel.replace(keyPattern, newLine) + content.slice(topLevelEnd);
    } else {
      const suffix = topLevel.endsWith("\n") || topLevel === "" ? "" : "\n";
      content = topLevel + suffix + newLine + "\n" + content.slice(topLevelEnd);
    }
  } else {
    const sectionHeader = `[${section}]`;
    const sectionIndex = content.indexOf(sectionHeader);
    if (sectionIndex !== -1) {
      const afterSection = content.slice(sectionIndex + sectionHeader.length);
      const nextSectionMatch = afterSection.match(/\n\[/);
      const sectionEnd = nextSectionMatch
        ? sectionIndex + sectionHeader.length + nextSectionMatch.index!
        : content.length;
      const sectionContent = content.slice(sectionIndex, sectionEnd);

      if (keyPattern.test(sectionContent)) {
        const updated = sectionContent.replace(keyPattern, newLine);
        content = content.slice(0, sectionIndex) + updated + content.slice(sectionEnd);
      } else {
        const insertPos = sectionIndex + sectionHeader.length;
        content = content.slice(0, insertPos) + `\n${newLine}` + content.slice(insertPos);
      }
    } else {
      const suffix = content.endsWith("\n") || content === "" ? "" : "\n";
      content += `${suffix}\n${sectionHeader}\n${newLine}\n`;
    }
  }

  await Bun.write(path, content);
}

function applyArrayUpdate(content: string, section: string, key: string, values: string[]): string {
  const tomlValue = values.length === 0
    ? "[]"
    : `[${values.map((v) => `"${v}"`).join(", ")}]`;
  const newLine = `${key} = ${tomlValue}`;
  const keyPattern = new RegExp(`^${key}\\s*=.*$`, "m");

  if (!section) {
    const firstSectionMatch = content.match(/^\[/m);
    const topLevelEnd = firstSectionMatch?.index ?? content.length;
    const topLevel = content.slice(0, topLevelEnd);

    if (keyPattern.test(topLevel)) {
      const updated = topLevel.replace(keyPattern, newLine);
      return updated + content.slice(topLevelEnd);
    }
    const suffix = topLevel.endsWith("\n") || topLevel === "" ? "" : "\n";
    return topLevel + suffix + newLine + "\n" + content.slice(topLevelEnd);
  }

  const sectionHeader = `[${section}]`;
  const sectionIndex = content.indexOf(sectionHeader);
  if (sectionIndex !== -1) {
    const afterSection = content.slice(sectionIndex + sectionHeader.length);
    const nextSectionMatch = afterSection.match(/\n\[/);
    const sectionEnd = nextSectionMatch
      ? sectionIndex + sectionHeader.length + nextSectionMatch.index!
      : content.length;
    const sectionContent = content.slice(sectionIndex, sectionEnd);

    if (keyPattern.test(sectionContent)) {
      const updated = sectionContent.replace(keyPattern, newLine);
      return content.slice(0, sectionIndex) + updated + content.slice(sectionEnd);
    }
    const insertPos = sectionIndex + sectionHeader.length;
    return content.slice(0, insertPos) + `\n${newLine}` + content.slice(insertPos);
  }

  const suffix = content.endsWith("\n") || content === "" ? "" : "\n";
  return content + `${suffix}\n${sectionHeader}\n${newLine}\n`;
}

export async function updateConfigArray(section: string, key: string, values: string[]): Promise<void> {
  const path = `${process.cwd()}/pgdev.toml`;
  const file = Bun.file(path);
  const content = (await file.exists()) ? await file.text() : "";
  await Bun.write(path, applyArrayUpdate(content, section, key, values));
}

export function updateConfigArraySync(section: string, key: string, values: string[]): void {
  const path = `${process.cwd()}/pgdev.toml`;
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    content = "";
  }
  writeFileSync(path, applyArrayUpdate(content, section, key, values));
}

export async function removeConfigKey(section: string, key: string): Promise<void> {
  const path = `${process.cwd()}/pgdev.toml`;
  const file = Bun.file(path);
  if (!(await file.exists())) return;
  let content = await file.text();

  const keyPattern = new RegExp(`^${key}\\s*=.*\\n?`, "m");

  if (!section) {
    const firstSectionMatch = content.match(/^\[/m);
    const topLevelEnd = firstSectionMatch?.index ?? content.length;
    const topLevel = content.slice(0, topLevelEnd);
    content = topLevel.replace(keyPattern, "") + content.slice(topLevelEnd);
  } else {
    const sectionHeader = `[${section}]`;
    const sectionIndex = content.indexOf(sectionHeader);
    if (sectionIndex === -1) return;
    const afterSection = content.slice(sectionIndex + sectionHeader.length);
    const nextSectionMatch = afterSection.match(/\n\[/);
    const sectionEnd = nextSectionMatch
      ? sectionIndex + sectionHeader.length + nextSectionMatch.index!
      : content.length;
    const sectionContent = content.slice(sectionIndex, sectionEnd);
    const updated = sectionContent.replace(keyPattern, "");
    content = content.slice(0, sectionIndex) + updated + content.slice(sectionEnd);
  }

  await Bun.write(path, content);
}

export function serializeToml(data: Record<string, unknown>, prefix = ""): string {
  let result = "";
  const scalars: [string, unknown][] = [];
  const sections: [string, Record<string, unknown>][] = [];

  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      sections.push([key, value as Record<string, unknown>]);
    } else {
      scalars.push([key, value]);
    }
  }

  for (const [key, value] of scalars) {
    result += `${key} = ${JSON.stringify(value)}\n`;
  }

  for (const [key, obj] of sections) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    result += `\n[${fullKey}]\n`;
    result += serializeToml(obj, fullKey);
  }

  return result;
}

// Keys that should exist in every pgdev.toml — missing ones are backfilled on startup.
// Adding a new config key? Add it here and it will be written to existing config files automatically.
const EXPECTED_KEYS: { section: string; key: string; raw: string }[] = [
  // Top-level
  { section: "", key: "env_file", raw: 'env_file = ""' },
  { section: "", key: "verbose", raw: "verbose = true" },
  // [tools]
  { section: "tools", key: "npgsqlrest", raw: 'npgsqlrest = "npgsqlrest"' },
  { section: "tools", key: "psql", raw: 'psql = "psql"' },
  { section: "tools", key: "pg_dump", raw: 'pg_dump = "pg_dump"' },
  { section: "tools", key: "pg_restore", raw: 'pg_restore = "pg_restore"' },
  // [npgsqlrest.commands]
  { section: "npgsqlrest.commands", key: "dev", raw: 'dev = ""' },
  { section: "npgsqlrest.commands", key: "validate", raw: 'validate = ""' },
  { section: "npgsqlrest.commands", key: "serve", raw: 'serve = ""' },
  { section: "npgsqlrest.commands", key: "validate-prod", raw: 'validate-prod = ""' },
  // [commands]
  { section: "commands", key: "schemas_query", raw: `schemas_query = "${defaults.commands.schemas_query}"` },
  // [project]
  { section: "project", key: "routines_dir", raw: 'routines_dir = ""' },
  { section: "project", key: "migrations_dir", raw: 'migrations_dir = ""' },
  { section: "project", key: "tests_dir", raw: 'tests_dir = ""' },
  { section: "project", key: "schemas", raw: "schemas = []" },
  { section: "project", key: "grants", raw: "# Track GRANT/REVOKE statements for routines\ngrants = false" },
  { section: "project", key: "ignore_body_whitespace", raw: "# Ignore whitespace differences in routine bodies when comparing\nignore_body_whitespace = false" },
  { section: "project", key: "api_dir", raw: "# Subdirectory within routines_dir for API (HTTP endpoint) routines\napi_dir = \"\"" },
  { section: "project", key: "internal_dir", raw: "# Subdirectory within routines_dir for internal (non-API) routines\ninternal_dir = \"\"" },
  { section: "project", key: "group_segment", raw: "# Group routines into subdirs by name segment (0 = disabled, 1 = first segment)\ngroup_segment = 0" },
  { section: "project", key: "skip_prefixes", raw: "# Prefixes to skip when grouping by name segment (empty = use built-in defaults)\n# skip_prefixes = [\"get\", \"set\", \"delete\", \"insert\", \"update\", \"create\", \"remove\", \"find\", \"list\", \"is\", \"has\", \"check\", \"count\", \"compute\", \"run\", \"do\", \"send\"]\nskip_prefixes = []" },
  { section: "project", key: "routine_types", raw: "# Object types to extract into individual files (excluded from schema.sql)\nroutine_types = [\"FUNCTION\", \"PROCEDURE\"]" },
  { section: "project", key: "group_order", raw: "# Directory nesting order. Each element adds a subdirectory level.\n# Available: \"type\" (api/internal), \"schema\", \"name\" (name segment), \"kind\" (function/procedure)\n# Example: [\"type\", \"schema\", \"name\"] → api/myschema/auth/get_auth_login.sql\ngroup_order = []" },
  { section: "project", key: "sync_skip", raw: "# Files to skip during sync (relative paths, managed via interactive sync)\nsync_skip = []" },
  // [format]
  { section: "format", key: "lowercase", raw: "# Lowercase SQL keywords in formatted output\nlowercase = true" },
  { section: "format", key: "param_style", raw: '# Parameter layout: "inline" or "multiline"\nparam_style = "multiline"' },
  { section: "format", key: "indent", raw: '# Indentation string\nindent = "    "' },
  { section: "format", key: "simplify_defaults", raw: "# Simplify default expressions (e.g. NULL::text → null)\nsimplify_defaults = true" },
  { section: "format", key: "omit_default_direction", raw: "# Omit IN direction (it's the default)\nomit_default_direction = true" },
  { section: "format", key: "attribute_style", raw: '# Attribute placement: "inline" or "multiline"\nattribute_style = "multiline"' },
  { section: "format", key: "strip_dump_comments", raw: "# Remove pg_dump header/footer comments\nstrip_dump_comments = true" },
  { section: "format", key: "comment_signature_style", raw: '# Comment signature: "types_only" or "full"\ncomment_signature_style = "types_only"' },
  { section: "format", key: "drop_before_create", raw: "# Add DROP IF EXISTS before CREATE statement\ndrop_before_create = true" },
  { section: "format", key: "create_or_replace", raw: "# Use CREATE OR REPLACE instead of CREATE\ncreate_or_replace = false" },
];

const SECTION_COMMENTS: Record<string, string> = {
  tools: "# Tool paths — bare command name uses PATH, or set a full path",
  "npgsqlrest.commands": '# NpgsqlRest run commands — value is the config file args passed to npgsqlrest CLI\n# Example: dev = "./config/production.json --optional ./config/development.json"',
  commands: "# SQL commands used by pgdev",
  project: "# Project directories for SQL source files\n# Leave empty to skip; directories are created when first needed",
  format: "# SQL formatter options for routine files generated by sync",
};

async function backfillConfig(path: string): Promise<void> {
  const data = await readToml(path);
  if (!data) return;

  const has = (section: string, key: string): boolean => {
    if (!section) return key in data;
    const parts = section.split(".");
    let obj: unknown = data;
    for (const p of parts) {
      if (typeof obj !== "object" || obj === null || !(p in (obj as Record<string, unknown>))) return false;
      obj = (obj as Record<string, unknown>)[p];
    }
    return typeof obj === "object" && obj !== null && key in (obj as Record<string, unknown>);
  };

  const missing = EXPECTED_KEYS.filter((e) => !has(e.section, e.key));
  if (missing.length === 0) return;

  // Group by section to insert all keys for a section at once
  const bySection = new Map<string, string[]>();
  for (const entry of missing) {
    const list = bySection.get(entry.section) ?? [];
    list.push(entry.raw);
    bySection.set(entry.section, list);
  }

  let content = await Bun.file(path).text();

  for (const [section, lines] of bySection) {
    const block = lines.join("\n");

    if (!section) {
      // Top-level: insert before first [section] header
      const firstSection = content.match(/^\[/m);
      const pos = firstSection?.index ?? content.length;
      const before = content.slice(0, pos);
      const suffix = before.endsWith("\n") || before === "" ? "" : "\n";
      content = before + suffix + block + "\n" + content.slice(pos);
    } else {
      const header = `[${section}]`;
      const headerIdx = content.indexOf(header);
      if (headerIdx !== -1) {
        // Section exists — append after header line
        const afterHeader = content.indexOf("\n", headerIdx);
        const insertPos = afterHeader !== -1 ? afterHeader : content.length;
        content = content.slice(0, insertPos) + "\n" + block + content.slice(insertPos);
      } else {
        // Section doesn't exist — create it
        const suffix = content.endsWith("\n") || content === "" ? "" : "\n";
        const comment = SECTION_COMMENTS[section];
        const commentLine = comment ? `${comment}\n` : "";
        content += `${suffix}\n${commentLine}${header}\n\n${block}\n`;
      }
    }
  }

  await Bun.write(path, content);
}

export async function ensureConfigFile(): Promise<boolean> {
  const path = `${process.cwd()}/pgdev.toml`;

  if (await Bun.file(path).exists()) {
    await backfillConfig(path);
    return false;
  }

  const envFileExists = await Bun.file(`${process.cwd()}/.ENV`).exists();
  const envFileValue = envFileExists ? ".ENV" : "";

  const content = `# Path to .env file for resolving {ENV_VAR} placeholders in config values
# Note: Bun automatically loads .ENV from the project root into process.env
env_file = "${envFileValue}"

# Show detailed output during tool detection and updates
verbose = true

# Tool paths — bare command name uses PATH, or set a full path
[tools]

npgsqlrest = "npgsqlrest"
psql = "psql"
pg_dump = "pg_dump"
pg_restore = "pg_restore"

# NpgsqlRest run commands — value is the config file args passed to npgsqlrest CLI
# Example: dev = "./config/production.json --optional ./config/development.json"
[npgsqlrest.commands]

dev = ""
validate = ""
serve = ""
validate-prod = ""

# SQL commands used by pgdev
[commands]

schemas_query = "${defaults.commands.schemas_query}"

# Database connection for pgdev tools (psql, pg_dump, pg_restore)
# Values support {ENV_VAR} placeholders resolved via env_file above
# To share connection with NpgsqlRest instead, set config_file to a JSON config path
[connection]

host = "{PGHOST}"
port = "{PGPORT}"
database = "{PGDATABASE}"
username = "{PGUSER}"
password = "{PGPASSWORD}"
# config_file = "./config/production.json"
# connection_name = "Default"

# Project directories for SQL source files
# Leave empty to skip; directories are created when first needed
[project]

routines_dir = ""
migrations_dir = ""
tests_dir = ""
# Schemas used by this project (empty = all non-system schemas)
schemas = []
# Track GRANT/REVOKE statements for routines
grants = false
# Ignore whitespace differences in routine bodies when comparing
ignore_body_whitespace = false
# Subdirectory within routines_dir for API (HTTP endpoint) routines
api_dir = ""
# Subdirectory within routines_dir for internal (non-API) routines
internal_dir = ""
# Group routines into subdirs by name segment (0 = disabled, 1 = first segment)
group_segment = 0
# Prefixes to skip when grouping by name segment (empty = use built-in defaults)
# skip_prefixes = ["get", "set", "delete", "insert", "update", "create", "remove", "find", "list", "is", "has", "check", "count", "compute", "run", "do", "send"]
skip_prefixes = []
# Object types to extract into individual files (excluded from schema.sql)
routine_types = ["FUNCTION", "PROCEDURE"]
# Directory nesting order. Each element adds a subdirectory level.
# Available: "type" (api/internal), "schema", "name" (name segment), "kind" (function/procedure)
# Example: ["type", "schema", "name"] → api/myschema/auth/get_auth_login.sql
group_order = []
# Files to skip during sync (relative paths, managed via interactive sync)
sync_skip = []

# SQL formatter options for routine files generated by sync
[format]

# Lowercase SQL keywords in formatted output
lowercase = true
# Parameter layout: "inline" or "multiline"
param_style = "multiline"
# Indentation string
indent = "    "
# Simplify default expressions (e.g. NULL::text → null)
simplify_defaults = true
# Omit IN direction (it's the default)
omit_default_direction = true
# Attribute placement: "inline" or "multiline"
attribute_style = "multiline"
# Remove pg_dump header/footer comments
strip_dump_comments = true
# Comment signature: "types_only" or "full"
comment_signature_style = "types_only"
# Add DROP IF EXISTS before CREATE statement
drop_before_create = true
# Use CREATE OR REPLACE instead of CREATE
create_or_replace = false
`;

  await Bun.write(path, content);
  console.log(success("Created pgdev.toml with default settings"));
  return true;
}

export async function loadConfig(): Promise<PgdevConfig> {
  const cwd = process.cwd();
  const project = await readToml(`${cwd}/pgdev.toml`);
  const local = await readToml(`${cwd}/pgdev.local.toml`);

  const projectNpgsqlrest = project?.npgsqlrest as Partial<NpgsqlRestConfig> | undefined;
  const localNpgsqlrest = local?.npgsqlrest as Partial<NpgsqlRestConfig> | undefined;

  return {
    ...defaults,
    ...project,
    ...local,
    tools: {
      ...defaults.tools,
      ...(project?.tools as Record<string, string> | undefined),
      ...(local?.tools as Record<string, string> | undefined),
    },
    npgsqlrest: {
      ...defaults.npgsqlrest,
      ...projectNpgsqlrest,
      ...localNpgsqlrest,
      commands: {
        ...projectNpgsqlrest?.commands,
        ...localNpgsqlrest?.commands,
      },
    },
    commands: {
      ...defaults.commands,
      ...(project?.commands as Partial<CommandsConfig> | undefined),
      ...(local?.commands as Partial<CommandsConfig> | undefined),
    },
    connection: {
      ...defaults.connection,
      ...(project?.connection as Partial<ConnectionConfig> | undefined),
      ...(local?.connection as Partial<ConnectionConfig> | undefined),
    },
    project: {
      ...defaults.project,
      ...(project?.project as Partial<ProjectConfig> | undefined),
      ...(local?.project as Partial<ProjectConfig> | undefined),
    },
    format: {
      ...defaults.format,
      ...(project?.format as Partial<FormatConfig> | undefined),
      ...(local?.format as Partial<FormatConfig> | undefined),
    },
  } as PgdevConfig;
}
