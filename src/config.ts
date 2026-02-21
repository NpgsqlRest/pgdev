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

export interface ProjectConfig {
  routines_dir: string;
  migrations_dir: string;
  tests_dir: string;
  schemas: string[];
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
  // [commands]
  { section: "commands", key: "schemas_query", raw: `schemas_query = "${defaults.commands.schemas_query}"` },
  // [project]
  { section: "project", key: "routines_dir", raw: 'routines_dir = ""' },
  { section: "project", key: "migrations_dir", raw: 'migrations_dir = ""' },
  { section: "project", key: "tests_dir", raw: 'tests_dir = ""' },
  { section: "project", key: "schemas", raw: "schemas = []" },
];

const SECTION_COMMENTS: Record<string, string> = {
  tools: "# Tool paths — bare command name uses PATH, or set a full path",
  commands: "# SQL commands used by pgdev",
  project: "# Project directories for SQL source files\n# Leave empty to skip; directories are created when first needed",
};

async function backfillConfig(path: string): Promise<void> {
  const data = await readToml(path);
  if (!data) return;

  const has = (section: string, key: string): boolean => {
    if (!section) return key in data;
    const sec = data[section];
    return typeof sec === "object" && sec !== null && key in (sec as Record<string, unknown>);
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
  } as PgdevConfig;
}
