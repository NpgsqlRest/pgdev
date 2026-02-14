import { $ } from "bun";
import { PACKAGE_NAME } from "../constants.ts";
import { spinner, success, error, pc, logCommand, type Spinner } from "../utils/terminal.ts";
import { getCurrentVersion, getLatestVersion, isNewer } from "../utils/version.ts";
import type { PgdevConfig } from "../config.ts";

function noopSpinner(): Spinner {
  return {
    stop(finalText?: string) {
      if (finalText) process.stderr.write(`${finalText}\n`);
    },
    update() {},
    pause() {},
    resume() {},
  };
}

export async function updateCommand(config: PgdevConfig): Promise<void> {
  const { verbose } = config;
  const s = verbose ? noopSpinner() : spinner("Checking for updates...");

  try {
    const currentVersion = getCurrentVersion();
    const latestVersion = await getLatestVersion();

    if (!isNewer(currentVersion, latestVersion)) {
      s.stop(success(`Already on the latest version ${pc.dim(`(v${currentVersion})`)}`));
      return;
    }

    s.update(`Updating ${PACKAGE_NAME} v${currentVersion} → v${latestVersion}...`);

    const installCmd = ["npm", "install", "-g", `${PACKAGE_NAME}@${latestVersion}`];
    let exitCode: number;
    let stderr = "";

    if (verbose) {
      logCommand(installCmd);
      const proc = Bun.spawn(installCmd, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      exitCode = await proc.exited;
    } else {
      const result = await $`${installCmd}`.quiet().nothrow();
      exitCode = result.exitCode;
      stderr = result.stderr.toString();
    }

    if (exitCode !== 0) {
      s.stop(error(`Failed to update ${PACKAGE_NAME}`));
      if (!verbose) console.error(pc.dim(stderr));
      process.exit(1);
    }

    s.stop(
      success(
        `Updated ${pc.bold(PACKAGE_NAME)} ${pc.dim(`v${currentVersion}`)} ${pc.dim("→")} ${pc.green(`v${latestVersion}`)}`
      )
    );
  } catch (err) {
    s.stop(error("Failed to check for updates"));
    console.error(pc.dim(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}
