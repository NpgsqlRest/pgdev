import { $ } from "bun";
import { PACKAGE_NAME } from "./constants.ts";
import { getCurrentVersion } from "./utils/version.ts";
import { pc } from "./utils/terminal.ts";
import { updateCommand } from "./commands/update.ts";
import { runCommand } from "./commands/run.ts";
import { initCommand } from "./commands/init.ts";
import { configCommand } from "./commands/config.ts";
import { loadConfig, type PgdevConfig } from "./config.ts";

export function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/);
}

function commandError(command: string, stderr: string): string {
  if (stderr.includes("command not found")) return `not found: ${command}`;
  return `error: ${stderr || "unknown failure"}`;
}

async function getNpgsqlRestVersion(command: string): Promise<string> {
  try {
    const parts = splitCommand(command);
    const result = await $`${parts} --version --json`.quiet().nothrow();
    if (result.exitCode !== 0) return commandError(command, result.stderr.toString().trim());
    const json = JSON.parse(result.stdout.toString()) as { versions?: { NpgsqlRest?: string } };
    return json.versions?.NpgsqlRest ?? "unknown output";
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function getPgToolVersion(command: string): Promise<string> {
  try {
    const parts = splitCommand(command);
    const result = await $`${parts} --version`.quiet().nothrow();
    if (result.exitCode !== 0) return commandError(command, result.stderr.toString().trim());
    const output = result.stdout.toString().trim();
    const match = output.match(/(\d+(?:\.\d+)+)/);
    return match?.[1] ?? "unknown output";
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function printVersion(): Promise<void> {
  const config = await loadConfig();
  const { tools } = config;

  const [npgsqlrest, psql, pgDump, pgRestore] = await Promise.all([
    getNpgsqlRestVersion(tools.npgsqlrest),
    getPgToolVersion(tools.psql),
    getPgToolVersion(tools.pg_dump),
    getPgToolVersion(tools.pg_restore),
  ]);

  const entries: [string, string][] = [
    [PACKAGE_NAME, getCurrentVersion()],
    ["npgsqlrest", npgsqlrest],
    ["psql", psql],
    ["pg_dump", pgDump],
    ["pg_restore", pgRestore],
  ];

  const maxLen = Math.max(...entries.map(([name]) => name.length));

  for (const [name, ver] of entries) {
    const label = name.padEnd(maxLen);
    const value =
      ver.startsWith("not found:") ? pc.dim(ver) :
      ver.startsWith("error:") ? pc.red(ver) :
      ver.startsWith("unknown") ? pc.yellow(ver) :
      pc.green(ver);
    console.log(`${label}  ${value}`);
  }
}

function printHelp(config?: PgdevConfig): void {
  const version = getCurrentVersion();
  let help = `
${pc.bold(PACKAGE_NAME)} ${pc.dim(`v${version}`)} - PostgreSQL and NpgsqlRest Development Toolchain

${pc.bold("Usage:")}
  ${PACKAGE_NAME} <command> [options]

${pc.bold("Commands:")}
  init            Set up tools and initialize config files
  setup           Alias for init
  config          Edit NpgsqlRest config files and pgdev connection
  update          Update ${PACKAGE_NAME} to the latest version
`;

  const commands = config?.npgsqlrest?.commands;
  if (commands && Object.keys(commands).length > 0) {
    help += `\n${pc.bold("NpgsqlRest Commands:")}  ${pc.dim("(from pgdev.toml)")}\n`;
    const maxLen = Math.max(...Object.keys(commands).map((k) => k.length));
    for (const [name, args] of Object.entries(commands)) {
      help += `  ${name.padEnd(Math.max(maxLen, 14))}  ${pc.dim(args)}\n`;
    }
  }

  help += `
${pc.bold("Options:")}
  --version, -v   Show version number
  --help, -h      Show this help message
`;

  console.log(help.trimStart());
}

export async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "--version" || command === "-v") {
    await printVersion();
    return;
  }

  const config = await loadConfig();

  if (!command || command === "--help" || command === "-h") {
    printHelp(config);
    return;
  }

  switch (command) {
    case "config":
      await configCommand(config);
      break;
    case "init":
    case "setup":
      await initCommand(config);
      break;
    case "update":
      await updateCommand(config);
      break;
    default:
      if (command === "detect") {
        console.log(pc.dim(`  "detect" has been merged into "init". Running "init" instead.\n`));
        await initCommand(config);
      } else if (config.npgsqlrest.commands[command]) {
        await runCommand(config, command, args.slice(1));
      } else {
        console.error(`Unknown command: ${pc.bold(command)}\n`);
        printHelp(config);
        process.exit(1);
      }
  }
}
