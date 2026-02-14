import { $ } from "bun";
import { PACKAGE_NAME } from "../constants.ts";
import { spinner, success, error, pc } from "../utils/terminal.ts";
import { getCurrentVersion, getLatestVersion, isNewer } from "../utils/version.ts";

export async function updateCommand(): Promise<void> {
  const s = spinner("Checking for updates...");

  try {
    const currentVersion = getCurrentVersion();
    const latestVersion = await getLatestVersion();

    if (!isNewer(currentVersion, latestVersion)) {
      s.stop(success(`Already on the latest version ${pc.dim(`(v${currentVersion})`)}`));
      return;
    }

    s.update(`Updating ${PACKAGE_NAME} v${currentVersion} → v${latestVersion}...`);

    const result = await $`npm install -g ${PACKAGE_NAME}@${latestVersion}`.quiet();

    if (result.exitCode !== 0) {
      s.stop(error(`Failed to update ${PACKAGE_NAME}`));
      console.error(pc.dim(result.stderr.toString()));
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
