import { error, pc } from "./utils/terminal.ts";

export interface NpgsqlRestConfig {
  commands: Record<string, string>;
}

export interface ConnectionConfig {
  mode: "shared" | "independent";
  config_file?: string;
  connection_name?: string;
  connection_string?: string;
}

export interface PgdevConfig {
  tools: {
    npgsqlrest: string;
    psql: string;
    pg_dump: string;
    pg_restore: string;
  };
  npgsqlrest: NpgsqlRestConfig;
  connection: ConnectionConfig;
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
  connection: {
    mode: "shared",
    connection_name: "Default",
  },
  verbose: false,
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

  const sectionHeader = `[${section}]`;
  const newLine = `${key} = "${value}"`;
  const keyPattern = new RegExp(`^${key}\\s*=.*$`, "m");

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
    connection: {
      ...defaults.connection,
      ...(project?.connection as Partial<ConnectionConfig> | undefined),
      ...(local?.connection as Partial<ConnectionConfig> | undefined),
    },
  } as PgdevConfig;
}
