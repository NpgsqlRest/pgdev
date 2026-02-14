import { $ } from "bun";
import { updateLocalConfig, type PgdevConfig } from "../config.ts";
import { success, error, info, pc, logCommand, type Spinner } from "../utils/terminal.ts";
import { ask, askPath } from "../utils/prompt.ts";

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

/** No-op spinner for verbose mode — just prints the final result line */
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
  // The wrapper script (npgsqlrest.js) looks for the binary in __dirname,
  // which is the package's bin/ directory inside node_modules.
  // `bun pm ls -g` first line: "/path/to/global node_modules (N)"
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

async function verifyNpgsqlRest(command: string): Promise<string | null> {
  try {
    const parts = command.trim().split(/\s+/);
    const result = await $`${parts} --version --json`.quiet().nothrow();
    if (result.exitCode !== 0) return null;
    const json = JSON.parse(result.stdout.toString()) as { versions?: { NpgsqlRest?: string } };
    return json.versions?.NpgsqlRest ?? null;
  } catch {
    return null;
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

  await updateLocalConfig("tools", "npgsqlrest", configValue);

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

async function installViaBinary(): Promise<string> {
  const asset = getBinaryAsset();
  if (!asset) {
    console.error(error(`No binary available for ${process.platform}-${process.arch}`));
    process.exit(1);
  }

  const destChoice = ask("Where should the binary be saved?", [
    { label: "./npgsqlrest" + asset.ext, description: "Current directory" },
    { label: "/usr/local/bin/npgsqlrest", description: "System-wide (may need sudo)" },
    { label: "Custom path", description: "Enter your own path" },
  ]);

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

  await updateLocalConfig("tools", "npgsqlrest", dest);

  const version = await verifyNpgsqlRest(dest);
  if (version) {
    s.stop(success(`Installed NpgsqlRest v${version}`));
  } else {
    s.stop(success(`Downloaded NpgsqlRest to ${dest}`));
    console.log(pc.dim("  Could not verify version — run pgdev -v to check."));
  }
  console.log(info(`Config updated: tools.npgsqlrest = "${dest}"`));

  return version ?? "";
}

async function installViaDocker(): Promise<string> {
  const variant = ask("Which Docker image variant?", [
    { label: "latest", description: "Standard AOT image" },
    { label: "latest-jit", description: "High-concurrency JIT image" },
    { label: "latest-arm", description: "ARM64 image" },
    { label: "latest-bun", description: "Bun runtime image" },
  ]);

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
  await updateLocalConfig("tools", "npgsqlrest", configValue);

  s.stop(success(`Pulled Docker image ${image}`));
  console.log(info(`Config updated: tools.npgsqlrest = "${configValue}"`));

  return tag;
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

async function verifyPgTool(command: string): Promise<string | null> {
  try {
    const parts = command.trim().split(/\s+/);
    const result = await $`${parts} --version`.quiet().nothrow();
    if (result.exitCode !== 0) return null;
    const output = result.stdout.toString().trim();
    const match = output.match(/(\d+(?:\.\d+)+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function setupPostgresTools(): Promise<void> {
  const pm = await detectPackageManager();
  if (!pm) {
    console.error(error("No supported package manager found (brew, apt, apk, dnf)"));
    process.exit(1);
  }

  let installCmd: string[];
  let packageDesc: string;

  if (pm === "brew") {
    const brewChoice = ask("What would you like to install?", [
      { label: "libpq", description: "Client tools only — psql, pg_dump, pg_restore (~7 MB, latest version)" },
      { label: "postgresql", description: "Full PostgreSQL server + client tools (~19 MB, pick version)" },
    ]);
    if (brewChoice === 0) {
      installCmd = ["brew", "install", "libpq"];
      packageDesc = "libpq";
    } else {
      const versionChoice = ask("Which PostgreSQL version?", [
        { label: "18", description: "Latest (PostgreSQL 18)" },
        { label: "17", description: "PostgreSQL 17" },
        { label: "16", description: "PostgreSQL 16" },
        { label: "15", description: "PostgreSQL 15" },
      ]);
      const versions = ["18", "17", "16", "15"];
      const version = versions[versionChoice];
      installCmd = ["brew", "install", `postgresql@${version}`];
      packageDesc = `postgresql@${version}`;
    }
  } else {
    const versionChoice = ask("Which PostgreSQL version?", [
      { label: "18", description: "Latest (PostgreSQL 18)" },
      { label: "17", description: "PostgreSQL 17" },
      { label: "16", description: "PostgreSQL 16" },
      { label: "15", description: "PostgreSQL 15" },
    ]);
    const versions = ["18", "17", "16", "15"];
    const version = versions[versionChoice];

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

    // Scan known brew paths for psql
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
    await updateLocalConfig("tools", "psql", psqlCmd);
    await updateLocalConfig("tools", "pg_dump", pgDumpCmd);
    await updateLocalConfig("tools", "pg_restore", pgRestoreCmd);
    s.stop(success(`Installed PostgreSQL client tools v${psqlVersion}`));
    console.log(info(`Config updated: tools.psql = "${psqlCmd}"`));
    console.log(info(`Config updated: tools.pg_dump = "${pgDumpCmd}"`));
    console.log(info(`Config updated: tools.pg_restore = "${pgRestoreCmd}"`));
  } else {
    s.stop(error("PostgreSQL client tools not found after install"));
    console.log(pc.dim(`  Run ${pc.bold("pgdev -v")} to check later.`));
  }
}

async function setupNpgsqlRest(): Promise<void> {
  const method = ask("How would you like to install NpgsqlRest?", [
    { label: "npm", description: "Install as npm package" },
    { label: "bun", description: "Install as bun package" },
    { label: "binary", description: "Download standalone executable" },
    { label: "docker", description: "Pull Docker image" },
  ]);

  if (method <= 1) {
    const pm = method === 0 ? "npm" : "bun" as const;
    const scope = ask("Install scope?", [
      { label: "local", description: "Project dependency (node_modules/.bin/)" },
      { label: "global", description: "System-wide installation" },
    ]);
    let dev = false;
    if (scope === 0) {
      const depType = ask("Dependency type?", [
        { label: "dependencies", description: "Production dependency" },
        { label: "devDependencies", description: "Development only (-D)" },
      ]);
      dev = depType === 1;
    }
    await installViaPackageManager(pm, scope === 0 ? "local" : "global", dev);
  } else if (method === 2) {
    await installViaBinary();
  } else {
    await installViaDocker();
  }
}

export async function setupCommand(_config: PgdevConfig): Promise<void> {
  const tool = ask("What would you like to set up?", [
    { label: "npgsqlrest", description: "NpgsqlRest server" },
    { label: "pg-tools", description: "PostgreSQL client tools (psql, pg_dump, pg_restore)" },
  ]);

  switch (tool) {
    case 0:
      await setupNpgsqlRest();
      break;
    case 1:
      await setupPostgresTools();
      break;
  }
}
