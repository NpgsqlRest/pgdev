import { error, pc } from "./utils/terminal.ts";

export interface PgdevConfig {
  project: {
    name: string;
  };
  tools: {
    npgsqlrest: string;
    psql: string;
    pg_dump: string;
    pg_restore: string;
  };
  verbose: boolean;
}

const defaults: PgdevConfig = {
  project: {
    name: "",
  },
  tools: {
    npgsqlrest: "npgsqlrest",
    psql: "psql",
    pg_dump: "pg_dump",
    pg_restore: "pg_restore",
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

export async function updateLocalConfig(section: string, key: string, value: string): Promise<void> {
  const path = `${process.cwd()}/pgdev.local.toml`;
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

export async function loadConfig(): Promise<PgdevConfig> {
  const cwd = process.cwd();
  const project = await readToml(`${cwd}/pgdev.toml`);
  const local = await readToml(`${cwd}/pgdev.local.toml`);

  return {
    ...defaults,
    ...project,
    ...local,
    tools: {
      ...defaults.tools,
      ...(project?.tools as Record<string, string> | undefined),
      ...(local?.tools as Record<string, string> | undefined),
    },
  } as PgdevConfig;
}
