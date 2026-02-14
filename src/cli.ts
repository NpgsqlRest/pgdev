import { PACKAGE_NAME } from "./constants.ts";
import { getCurrentVersion } from "./utils/version.ts";
import { pc } from "./utils/terminal.ts";
import { updateCommand } from "./commands/update.ts";

function printVersion(): void {
  console.log(`${PACKAGE_NAME} v${getCurrentVersion()}`);
}

function printHelp(): void {
  const version = getCurrentVersion();
  console.log(`
${pc.bold(PACKAGE_NAME)} ${pc.dim(`v${version}`)} - PostgreSQL Development Toolchain

${pc.bold("Usage:")}
  ${PACKAGE_NAME} <command> [options]

${pc.bold("Commands:")}
  update          Update ${PACKAGE_NAME} to the latest version

${pc.bold("Options:")}
  --version, -v   Show version number
  --help, -h      Show this help message
`.trimStart());
}

export async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    printVersion();
    return;
  }

  switch (command) {
    case "update":
      await updateCommand();
      break;
    default:
      console.error(`Unknown command: ${pc.bold(command)}\n`);
      printHelp();
      process.exit(1);
  }
}
