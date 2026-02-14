import { type PgdevConfig } from "../config.ts";
import { error, info, pc, logCommand } from "../utils/terminal.ts";
import { splitCommand } from "../cli.ts";

export async function runCommand(
  config: PgdevConfig,
  commandName: string,
  extraArgs: string[],
): Promise<void> {
  const commandStr = config.npgsqlrest.commands[commandName];
  if (!commandStr) {
    console.error(error(`Unknown command: ${pc.bold(commandName)}`));
    const available = Object.keys(config.npgsqlrest.commands);
    if (available.length > 0) {
      console.log(info(`Available commands: ${available.join(", ")}`));
    } else {
      console.log(pc.dim(`  No commands defined. Run ${pc.bold("pgdev init")} to set up.`));
    }
    process.exit(1);
  }

  const toolCmd = splitCommand(config.tools.npgsqlrest);
  const args = commandStr.trim().split(/\s+/);
  const cmd = [...toolCmd, ...args, ...extraArgs];

  logCommand(cmd);
  const proc = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await proc.exited);
}
