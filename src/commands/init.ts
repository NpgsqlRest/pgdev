import { loadConfig, serializeToml, updateConfig, type PgdevConfig } from "../config.ts";
import { spinner, success, error, info, pc } from "../utils/terminal.ts";
import { ask, askConfirm, askPath } from "../utils/prompt.ts";
import { readJsonConfig } from "../utils/json.ts";
import { editTopLevelConfig, configurePgdevConnection } from "./config.ts";
import { setupNpgsqlRest, setupPostgresTools } from "./setup.ts";
import { detectNpgsqlRest, detectPgTools, type PgInstallation } from "../utils/tools.ts";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

// --- Tool setup (merged detect + setup) ---

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

async function setupTools(_config: PgdevConfig): Promise<{ npgsqlrest: boolean; pgtools: boolean }> {
  let npgsqlrestConfigured = false;
  let pgtoolsConfigured = false;

  // === NpgsqlRest Detection + Setup ===
  const s = spinner("Detecting NpgsqlRest installation...");
  const npgsqlResult = await detectNpgsqlRest(false);

  if (npgsqlResult) {
    s.stop(success(`Found NpgsqlRest v${npgsqlResult.version}`));
    console.log(pc.dim(`  Source: ${npgsqlResult.source}`));

    const choice = await ask("Use this installation?", [
      { label: `Use ${npgsqlResult.command}`, description: `v${npgsqlResult.version}` },
      { label: "Set up differently", description: "Install via npm, bun, binary, or docker" },
      { label: "Skip", description: "Don't configure NpgsqlRest now" },
    ]);

    if (choice === 0) {
      await updateConfig("tools", "npgsqlrest", npgsqlResult.command);
      console.log(info(`Config updated: tools.npgsqlrest = "${npgsqlResult.command}"`));
      npgsqlrestConfigured = true;
    } else if (choice === 1) {
      await setupNpgsqlRest();
      npgsqlrestConfigured = true;
    }
  } else {
    s.stop(error("No NpgsqlRest installation found"));

    const choice = await ask("What would you like to do?", [
      { label: "Install now", description: "Set up NpgsqlRest" },
      { label: "Skip", description: "Configure later" },
    ]);

    if (choice === 0) {
      await setupNpgsqlRest();
      npgsqlrestConfigured = true;
    }
  }

  // === PostgreSQL Tools Detection + Setup ===
  const ps = spinner("Detecting PostgreSQL client tools...");
  const pgInstalls = await detectPgTools(false);

  if (pgInstalls.length === 0) {
    ps.stop(error("No PostgreSQL client tools found"));

    const choice = await ask("What would you like to do?", [
      { label: "Install now", description: "Set up PostgreSQL client tools" },
      { label: "Skip", description: "Configure later" },
    ]);

    if (choice === 0) {
      await setupPostgresTools();
      pgtoolsConfigured = true;
    }
  } else if (pgInstalls.length === 1) {
    const chosen = pgInstalls[0];
    ps.stop(success(`Found PostgreSQL client tools v${chosen.version}`));
    console.log(pc.dim(`  Source: ${chosen.source}`));

    const choice = await ask("Use this installation?", [
      { label: "Use detected", description: `v${chosen.version} (${chosen.source})` },
      { label: "Set up differently", description: "Install via package manager" },
      { label: "Skip", description: "Don't configure PostgreSQL tools now" },
    ]);

    if (choice === 0) {
      await savePgTools(chosen);
      pgtoolsConfigured = true;
    } else if (choice === 1) {
      await setupPostgresTools();
      pgtoolsConfigured = true;
    }
  } else {
    ps.stop(success(`Found ${pgInstalls.length} PostgreSQL installations`));

    const options = pgInstalls.map((p) => ({
      label: `v${p.version}`,
      description: p.binDir ? `${p.source} (${p.binDir})` : p.source,
    }));
    options.push({ label: "Set up differently", description: "Install via package manager" });
    options.push({ label: "Skip", description: "Don't configure PostgreSQL tools now" });

    const choice = await ask("Which installation should pgdev use?", options);

    if (choice >= 0 && choice < pgInstalls.length) {
      await savePgTools(pgInstalls[choice]);
      pgtoolsConfigured = true;
    } else if (choice === pgInstalls.length) {
      await setupPostgresTools();
      pgtoolsConfigured = true;
    }
  }

  return { npgsqlrest: npgsqlrestConfigured, pgtools: pgtoolsConfigured };
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

async function askConfigDir(): Promise<string | null> {
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

  const choice = await ask("Where should config files live?", options);
  if (choice === -1) return null;

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

async function initNpgsqlRest(config: PgdevConfig): Promise<void> {
  const configDir = await askConfigDir();
  if (configDir === null) return;

  const structureChoice = await ask("Config file structure?", [
    { label: "Single file", description: "One appsettings.json" },
    { label: "Dev + Prod", description: "Separate development and production configs" },
    { label: "Dev + Prod + Local", description: "Plus personal overrides, gitignored (recommended)" },
  ]);
  if (structureChoice === -1) return;

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

  // Offer to configure top-level settings in the primary config file
  const primaryFile = structureChoice === 0
    ? `${prefix}${appsettings.file}`
    : `${prefix}${production.file}`;
  const primaryFullPath = resolve(process.cwd(), primaryFile);
  const primaryConfig = await readJsonConfig(primaryFullPath);

  if (primaryConfig && askConfirm("Configure top-level settings (ApplicationName, Urls, etc.)?")) {
    await editTopLevelConfig(primaryConfig.data, primaryConfig.header, primaryFullPath, config);
  }

  console.log();
  console.log(success("NpgsqlRest config initialized"));
  if (commands.serve) {
    console.log(pc.dim(`  Run ${pc.bold("pgdev dev")} to start with development config`));
    console.log(pc.dim(`  Run ${pc.bold("pgdev serve")} to start with production config`));
  } else {
    console.log(pc.dim(`  Run ${pc.bold("pgdev dev")} to start`));
  }
}

// --- Main entry ---

export async function initCommand(config: PgdevConfig): Promise<void> {
  while (true) {
    const choice = await ask("What would you like to do?", [
      { label: "Set up tools", description: "Detect and install NpgsqlRest and PostgreSQL tools" },
      { label: "NpgsqlRest config", description: "Create config files and commands" },
    ], { exit: true });

    if (choice === -1) return;

    if (choice === 0) {
      const result = await setupTools(config);

      // Reload config to pick up freshly-saved tool paths
      const freshConfig = await loadConfig();

      if (result.pgtools) {
        if (askConfirm("Configure database connection now?")) {
          await configurePgdevConnection(freshConfig);
        }
      }

      if (result.npgsqlrest) {
        if (askConfirm("Initialize NpgsqlRest config files now?")) {
          await initNpgsqlRest(freshConfig);
        }
      }
    } else if (choice === 1) {
      await initNpgsqlRest(config);
    }
  }
}
