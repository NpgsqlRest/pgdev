import { serializeToml, type PgdevConfig } from "../config.ts";
import { success, info, pc } from "../utils/terminal.ts";
import { ask, askConfirm, askPath } from "../utils/prompt.ts";
import { readdirSync } from "node:fs";

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

function listExistingDirs(): string[] {
  const cwd = process.cwd();
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

const TEMPLATE_DIRS = ["config", "npgsqlrest", "server"];

function askConfigDir(): string {
  const existingDirs = listExistingDirs();
  const seen = new Set<string>();
  const options: { label: string; description: string }[] = [];

  // Root directory
  options.push({ label: ".", description: "Project root" });
  seen.add(".");

  // Existing directories
  for (const dir of existingDirs) {
    if (TEMPLATE_DIRS.includes(dir)) continue;
    options.push({ label: dir, description: "Existing directory" });
    seen.add(dir);
  }

  // Template directories (mark existing ones)
  for (const dir of TEMPLATE_DIRS) {
    if (seen.has(dir)) continue;
    const exists = existingDirs.includes(dir);
    options.push({ label: dir, description: exists ? "Existing directory" : "Will be created" });
    seen.add(dir);
  }

  // Custom input
  options.push({ label: "Custom path...", description: "Type a directory path" });

  const choice = ask("Where should config files live?", options);

  if (choice === options.length - 1) {
    return askPath("Enter config directory path", ".");
  }

  return options[choice].label;
}

async function mergeTomlConfig(
  tomlPath: string,
  commands: Record<string, string>,
): Promise<void> {
  const file = Bun.file(tomlPath);
  const exists = await file.exists();
  let existing: Record<string, unknown> = {};

  if (exists) {
    try {
      existing = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
    } catch {
      // If parse fails, treat as empty
    }
  }

  // Show what will be configured
  console.log();
  console.log(`  ${pc.bold("pgdev.toml")} — the following keys will be ${exists ? "set" : "created"}:`);
  console.log();
  console.log(pc.dim(`  [npgsqlrest.commands]`));
  for (const [name, value] of Object.entries(commands)) {
    console.log(pc.dim(`  ${name} = "${value}"`));
  }
  console.log();

  if (!askConfirm(exists ? "Update pgdev.toml with these keys?" : "Create pgdev.toml?", true)) {
    console.log(pc.dim(`  Skipped pgdev.toml`));
    return;
  }

  // Merge npgsqlrest.commands into existing config
  const existingNpgsqlrest = (existing.npgsqlrest ?? {}) as Record<string, unknown>;
  const existingCommands = (existingNpgsqlrest.commands ?? {}) as Record<string, string>;

  existing.npgsqlrest = {
    ...existingNpgsqlrest,
    commands: {
      ...existingCommands,
      ...commands,
    },
  };

  await Bun.write(tomlPath, serializeToml(existing));
  console.log(success(exists ? `Updated pgdev.toml` : `Created pgdev.toml`));
}

async function initNpgsqlRest(_config: PgdevConfig): Promise<void> {
  const configDir = askConfigDir();

  const structureChoice = ask("Config file structure?", [
    { label: "Single file", description: "One appsettings.json" },
    { label: "Dev + Prod", description: "Separate development and production configs" },
    { label: "Dev + Prod + Local", description: "Plus personal overrides, gitignored (recommended)" },
  ]);

  // Create config directory if needed
  if (configDir !== ".") {
    const dir = `${process.cwd()}/${configDir}`;
    const { mkdirSync } = await import("node:fs");
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

  const tomlPath = `${process.cwd()}/pgdev.toml`;
  await mergeTomlConfig(tomlPath, commands);

  console.log();
  console.log(success("NpgsqlRest config initialized"));
  if (commands.serve) {
    console.log(pc.dim(`  Run ${pc.bold("pgdev dev")} to start with development config`));
    console.log(pc.dim(`  Run ${pc.bold("pgdev serve")} to start with production config`));
  } else {
    console.log(pc.dim(`  Run ${pc.bold("pgdev dev")} to start`));
  }
}

export async function initCommand(config: PgdevConfig): Promise<void> {
  const tool = ask("What would you like to initialize?", [
    { label: "npgsqlrest", description: "NpgsqlRest server config files and commands" },
  ]);

  switch (tool) {
    case 0:
      await initNpgsqlRest(config);
      break;
  }
}
