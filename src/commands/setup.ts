import { $ } from "bun";
import { updateConfig } from "../config.ts";
import { success, error, info, pc, logCommand } from "../utils/terminal.ts";
import { ask, askPath } from "../utils/prompt.ts";
import { noopSpinner, verifyNpgsqlRest, verifyPgTool } from "../utils/tools.ts";

const GITHUB_RELEASE_URL = "https://github.com/NpgsqlRest/NpgsqlRest/releases/latest/download";

function getBinaryAsset(): { asset: string; ext: string } | null {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") return { asset: "npgsqlrest-osx-arm64", ext: "" };
  if (platform === "linux" && arch === "x64") return { asset: "npgsqlrest-linux64", ext: "" };
  if (platform === "linux" && arch === "arm64") return { asset: "npgsqlrest-linux-arm64", ext: "" };
  if (platform === "win32" && arch === "x64") return { asset: "npgsqlrest-win64.exe", ext: ".exe" };
  return null;
}

interface ExecResult {
  exitCode: number;
  stderr: string;
}

/** Run a system command with inherited TTY for native output. */
async function exec(cmd: string[]): Promise<ExecResult> {
  logCommand(cmd);
  const proc = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  return { exitCode, stderr: "" };
}

async function getBunGlobalPackageBinDir(): Promise<string> {
  const result = await $`bun pm ls -g`.quiet().nothrow();
  const firstLine = result.stdout.toString().split("\n")[0];
  const globalRoot = firstLine.replace(/ node_modules.*$/, "").trim();
  return `${globalRoot}/node_modules/npgsqlrest/bin`;
}

async function downloadBinary(dest: string): Promise<void> {
  const asset = getBinaryAsset();
  if (!asset) return;

  const url = `${GITHUB_RELEASE_URL}/${asset.asset}`;
  const filePath = `${dest}/npgsqlrest${asset.ext}`;

  logCommand(["fetch", url]);
  const response = await fetch(url);
  if (!response.ok) return;

  const buffer = await response.arrayBuffer();
  await Bun.write(filePath, buffer);
  if (process.platform !== "win32") {
    await $`chmod +x ${filePath}`.quiet().nothrow();
  }
}

async function installViaPackageManager(pm: "npm" | "bun", scope: "local" | "global", dev: boolean): Promise<string> {
  const s = noopSpinner();

  let installCmd: string[];
  let configValue: string;

  if (pm === "npm" && scope === "local") {
    installCmd = dev ? ["npm", "install", "-D", "npgsqlrest"] : ["npm", "install", "npgsqlrest"];
    configValue = "npx npgsqlrest";
  } else if (pm === "npm" && scope === "global") {
    installCmd = ["npm", "install", "-g", "npgsqlrest"];
    configValue = "npgsqlrest";
  } else if (pm === "bun" && scope === "local") {
    installCmd = dev ? ["bun", "add", "-D", "npgsqlrest"] : ["bun", "add", "npgsqlrest"];
    configValue = "bunx npgsqlrest";
  } else {
    installCmd = ["bun", "install", "-g", "npgsqlrest"];
    configValue = "npgsqlrest";
  }

  const result = await exec(installCmd);
  if (result.exitCode !== 0) {
    s.stop(error(`Failed to install NpgsqlRest via ${pm}`));
    process.exit(1);
  }

  // Bun blocks postinstall by default. If bun add already ran it (package
  // was previously trusted), the binary is ready. Otherwise, trust it now.
  // For global installs, bun pm trust doesn't work — download binary directly.
  if (pm === "bun") {
    s.update("Verifying NpgsqlRest binary...");
    const alreadyWorks = await verifyNpgsqlRest(configValue);
    if (!alreadyWorks && scope === "local") {
      s.update("Downloading NpgsqlRest binary (this may take a few minutes)...");
      await exec(["bun", "pm", "trust", "npgsqlrest"]);
    } else if (!alreadyWorks && scope === "global") {
      s.update("Downloading NpgsqlRest binary...");
      await downloadBinary(await getBunGlobalPackageBinDir());
    }
  }

  await updateConfig("tools", "npgsqlrest", configValue);

  s.update("Verifying NpgsqlRest binary...");
  const version = await verifyNpgsqlRest(configValue);
  if (version) {
    s.stop(success(`Installed NpgsqlRest v${version}`));
  } else {
    s.stop(error("NpgsqlRest binary not found after install"));
    console.log(pc.dim(`  Run ${pc.bold("pgdev -v")} to check later.`));
  }
  console.log(info(`Config updated: tools.npgsqlrest = "${configValue}"`));

  return version ?? "";
}

async function installViaBinary(): Promise<void> {
  const asset = getBinaryAsset();
  if (!asset) {
    console.error(error(`No binary available for ${process.platform}-${process.arch}`));
    process.exit(1);
  }

  const destChoice = await ask("Where should the binary be saved?", [
    { label: "./npgsqlrest" + asset.ext, description: "Current directory" },
    { label: "/usr/local/bin/npgsqlrest", description: "System-wide (may need sudo)" },
    { label: "Custom path", description: "Enter your own path" },
  ]);
  if (destChoice === -1) return;

  let dest: string;
  if (destChoice === 0) {
    dest = `${process.cwd()}/npgsqlrest${asset.ext}`;
  } else if (destChoice === 1) {
    dest = "/usr/local/bin/npgsqlrest";
  } else {
    dest = askPath("Enter destination path:", `./npgsqlrest${asset.ext}`);
  }

  const url = `${GITHUB_RELEASE_URL}/${asset.asset}`;
  const s = noopSpinner();

  try {
    logCommand(["fetch", url]);
    const response = await fetch(url);
    if (!response.ok) {
      s.stop(error(`Download failed: ${response.statusText}`));
      process.exit(1);
    }
    const buffer = await response.arrayBuffer();
    await Bun.write(dest, buffer);
    if (process.platform !== "win32") {
      await exec(["chmod", "+x", dest]);
    }
  } catch (err) {
    s.stop(error("Download failed"));
    console.error(pc.dim(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  await updateConfig("tools", "npgsqlrest", dest);

  const version = await verifyNpgsqlRest(dest);
  if (version) {
    s.stop(success(`Installed NpgsqlRest v${version}`));
  } else {
    s.stop(success(`Downloaded NpgsqlRest to ${dest}`));
    console.log(pc.dim("  Could not verify version — run pgdev -v to check."));
  }
  console.log(info(`Config updated: tools.npgsqlrest = "${dest}"`));
}

async function installViaDocker(): Promise<void> {
  const variant = await ask("Which Docker image variant?", [
    { label: "latest", description: "Standard AOT image" },
    { label: "latest-jit", description: "High-concurrency JIT image" },
    { label: "latest-arm", description: "ARM64 image" },
    { label: "latest-bun", description: "Bun runtime image" },
  ]);
  if (variant === -1) return;

  const tags = ["latest", "latest-jit", "latest-arm", "latest-bun"];
  const tag = tags[variant];
  const image = `vbilopav/npgsqlrest:${tag}`;

  const s = noopSpinner();

  const result = await exec(["docker", "pull", image]);
  if (result.exitCode !== 0) {
    s.stop(error(`Failed to pull ${image}`));
    process.exit(1);
  }

  const configValue = `docker run --rm ${image}`;
  await updateConfig("tools", "npgsqlrest", configValue);

  s.stop(success(`Pulled Docker image ${image}`));
  console.log(info(`Config updated: tools.npgsqlrest = "${configValue}"`));
}

async function detectPackageManager(): Promise<"brew" | "apt" | "apk" | "dnf" | null> {
  const checks = [
    { cmd: "brew", pm: "brew" as const },
    { cmd: "apt-get", pm: "apt" as const },
    { cmd: "apk", pm: "apk" as const },
    { cmd: "dnf", pm: "dnf" as const },
  ];
  for (const { cmd, pm } of checks) {
    const result = await $`which ${cmd}`.quiet().nothrow();
    if (result.exitCode === 0) return pm;
  }
  return null;
}

export async function setupPostgresTools(): Promise<void> {
  const pm = await detectPackageManager();
  if (!pm) {
    console.error(error("No supported package manager found (brew, apt, apk, dnf)"));
    process.exit(1);
  }

  let installCmd: string[];
  let packageDesc: string;

  if (pm === "brew") {
    const choice = await ask("How would you like to install PostgreSQL tools?", [
      { label: "brew install libpq", description: "Client tools only — psql, pg_dump, pg_restore (~7 MB)" },
      { label: "brew install postgresql@18", description: "Full PostgreSQL 18 server + client" },
      { label: "brew install postgresql@17", description: "Full PostgreSQL 17 server + client" },
      { label: "brew install postgresql@16", description: "Full PostgreSQL 16 server + client" },
      { label: "brew install postgresql@15", description: "Full PostgreSQL 15 server + client" },
    ]);
    if (choice === -1) return;
    if (choice === 0) {
      installCmd = ["brew", "install", "libpq"];
      packageDesc = "libpq";
    } else {
      const versions = ["18", "17", "16", "15"];
      const version = versions[choice - 1];
      installCmd = ["brew", "install", `postgresql@${version}`];
      packageDesc = `postgresql@${version}`;
    }
  } else {
    const versions = ["18", "17", "16", "15"];
    const choice = await ask(`Install PostgreSQL client tools via ${pm}?`, versions.map((v, i) => ({
      label: `PostgreSQL ${v}`,
      description: i === 0 ? "Latest" : "",
    })));
    if (choice === -1) return;
    const version = versions[choice];

    switch (pm) {
      case "apt":
        installCmd = ["sudo", "apt-get", "install", "-y", `postgresql-client-${version}`];
        packageDesc = `postgresql-client-${version}`;
        break;
      case "apk":
        installCmd = ["apk", "add", "--no-cache", `postgresql${version}-client`];
        packageDesc = `postgresql${version}-client`;
        break;
      case "dnf":
        installCmd = ["sudo", "dnf", "install", "-y", `postgresql${version}`];
        packageDesc = `postgresql${version}`;
        break;
    }
  }

  const s = noopSpinner();

  const result = await exec(installCmd);
  if (result.exitCode !== 0) {
    s.stop(error(`Failed to install PostgreSQL client tools via ${pm}`));
    process.exit(1);
  }

  // Find the installed binaries
  let psqlCmd = "psql";
  let pgDumpCmd = "pg_dump";
  let pgRestoreCmd = "pg_restore";

  if (pm === "brew") {
    const brewPrefixResult = await $`brew --prefix ${packageDesc}`.quiet().nothrow();
    const brewPrefix = brewPrefixResult.exitCode === 0
      ? brewPrefixResult.stdout.toString().trim()
      : null;

    const candidates = [
      brewPrefix ? `${brewPrefix}/bin` : null,
      `/opt/homebrew/opt/${packageDesc}/bin`,
      `/usr/local/opt/${packageDesc}/bin`,
    ].filter(Boolean) as string[];

    for (const binDir of candidates) {
      if (await Bun.file(`${binDir}/psql`).exists()) {
        psqlCmd = `${binDir}/psql`;
        pgDumpCmd = `${binDir}/pg_dump`;
        pgRestoreCmd = `${binDir}/pg_restore`;
        break;
      }
    }
  }

  // Verify and update config
  const psqlVersion = await verifyPgTool(psqlCmd);
  if (psqlVersion) {
    await updateConfig("tools", "psql", psqlCmd);
    await updateConfig("tools", "pg_dump", pgDumpCmd);
    await updateConfig("tools", "pg_restore", pgRestoreCmd);
    s.stop(success(`Installed PostgreSQL client tools v${psqlVersion}`));
    console.log(info(`Config updated: tools.psql = "${psqlCmd}"`));
    console.log(info(`Config updated: tools.pg_dump = "${pgDumpCmd}"`));
    console.log(info(`Config updated: tools.pg_restore = "${pgRestoreCmd}"`));
  } else {
    s.stop(error("PostgreSQL client tools not found after install"));
    console.log(pc.dim(`  Run ${pc.bold("pgdev -v")} to check later.`));
  }
}

export async function setupNpgsqlRest(): Promise<void> {
  const choice = await ask("How would you like to install NpgsqlRest?", [
    { label: "npm (local, devDependency)", description: "npm install -D npgsqlrest" },
    { label: "npm (local, dependency)", description: "npm install npgsqlrest" },
    { label: "npm (global)", description: "npm install -g npgsqlrest" },
    { label: "bun (local, devDependency)", description: "bun add -D npgsqlrest" },
    { label: "bun (local, dependency)", description: "bun add npgsqlrest" },
    { label: "bun (global)", description: "bun add -g npgsqlrest" },
    { label: "Binary download", description: "Download standalone executable" },
    { label: "Docker", description: "Pull Docker image" },
  ]);
  if (choice === -1) return;

  if (choice <= 5) {
    const pm: "npm" | "bun" = choice <= 2 ? "npm" : "bun";
    const scope: "local" | "global" = choice % 3 === 2 ? "global" : "local";
    const dev = choice % 3 === 0;
    await installViaPackageManager(pm, scope, dev);
  } else if (choice === 6) {
    await installViaBinary();
  } else {
    await installViaDocker();
  }
}
