import { $ } from "bun";
import { updateLocalConfig, type PgdevConfig } from "../config.ts";
import { spinner, success, error, info, pc, logCommand, type Spinner } from "../utils/terminal.ts";
import { ask } from "../utils/prompt.ts";

interface Detection {
  command: string;
  version: string;
  source: string;
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

async function tryNpgsqlRest(command: string, verbose: boolean): Promise<string | null> {
  try {
    const parts = command.trim().split(/\s+/);
    const cmd = [...parts, "--version", "--json"];
    if (verbose) {
      logCommand(cmd);
      const proc = Bun.spawn(cmd, {
        stdin: "inherit",
        stdout: "pipe",
        stderr: "inherit",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) return null;
      const stdout = await new Response(proc.stdout).text();
      process.stdout.write(stdout);
      const json = JSON.parse(stdout) as { versions?: { NpgsqlRest?: string } };
      return json.versions?.NpgsqlRest ?? null;
    }
    const result = await $`${cmd}`.quiet().nothrow();
    if (result.exitCode !== 0) return null;
    const json = JSON.parse(result.stdout.toString()) as { versions?: { NpgsqlRest?: string } };
    return json.versions?.NpgsqlRest ?? null;
  } catch {
    return null;
  }
}

async function detectNpgsqlRest(verbose: boolean): Promise<Detection | null> {
  const cwd = process.cwd();
  const ext = process.platform === "win32" ? ".exe" : "";

  // 1. Check standalone binary in current directory
  const localBinary = `${cwd}/npgsqlrest${ext}`;
  if (await Bun.file(localBinary).exists()) {
    const localBinaryVersion = await tryNpgsqlRest(localBinary, verbose);
    if (localBinaryVersion) {
      return { command: `./npgsqlrest${ext}`, version: localBinaryVersion, source: "standalone binary in current directory" };
    }
  }

  // 2. Check local node_modules
  const localBin = `${cwd}/node_modules/.bin/npgsqlrest`;
  const localVersion = await tryNpgsqlRest(localBin, verbose);
  if (localVersion) {
    const hasBunLock = await Bun.file(`${cwd}/bun.lockb`).exists() ||
                       await Bun.file(`${cwd}/bun.lock`).exists();
    const command = hasBunLock ? "bunx npgsqlrest" : "npx npgsqlrest";
    return { command, version: localVersion, source: `local ${hasBunLock ? "bun" : "npm"} package` };
  }

  // 3. Check direct PATH
  const directVersion = await tryNpgsqlRest("npgsqlrest", verbose);
  if (directVersion) {
    return { command: "npgsqlrest", version: directVersion, source: "global install or standalone binary" };
  }

  // 3. Check docker — try platform-appropriate tags
  const dockerTags = process.arch === "arm64"
    ? ["latest-arm", "latest-bun", "latest", "latest-jit"]
    : ["latest", "latest-jit", "latest-arm", "latest-bun"];

  for (const tag of dockerTags) {
    const image = `vbilopav/npgsqlrest:${tag}`;
    const inspectCmd = ["docker", "image", "inspect", image];
    if (verbose) {
      logCommand(inspectCmd);
      const proc = Bun.spawn(inspectCmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      if ((await proc.exited) !== 0) continue;
    } else {
      const result = await $`${inspectCmd}`.quiet().nothrow();
      if (result.exitCode !== 0) continue;
    }
    const dockerVersion = await tryNpgsqlRest(`docker run --rm ${image}`, verbose);
    if (dockerVersion) {
      return { command: `docker run --rm ${image}`, version: dockerVersion, source: `Docker image (${tag})` };
    }
  }

  return null;
}

interface PgInstallation {
  binDir: string | null;  // null = bare commands on PATH
  version: string;
  source: string;
}

async function tryPsqlVersion(psqlPath: string): Promise<string | null> {
  try {
    const cmd = [psqlPath, "--version"];
    const result = await $`${cmd}`.quiet().nothrow();
    if (result.exitCode !== 0) return null;
    const output = result.stdout.toString().trim();
    const match = output.match(/(\d+(?:\.\d+)+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function detectPgTools(verbose: boolean): Promise<PgInstallation[]> {
  const found: PgInstallation[] = [];
  const seen = new Set<string>();

  async function check(binDir: string, source: string): Promise<void> {
    const psqlPath = `${binDir}/psql`;
    if (seen.has(psqlPath)) return;
    seen.add(psqlPath);

    if (verbose) logCommand([psqlPath, "--version"]);
    const version = await tryPsqlVersion(psqlPath);
    if (version) {
      found.push({ binDir, version, source });
    }
  }

  // 1. Check bare psql on PATH first
  if (verbose) logCommand(["psql", "--version"]);
  const pathVersion = await tryPsqlVersion("psql");
  if (pathVersion) {
    found.push({ binDir: null, version: pathVersion, source: "PATH (default)" });
  }

  // 2. Scan known directories
  const versions = ["18", "17", "16", "15", "14"];

  // Homebrew (Apple Silicon)
  for (const v of versions) {
    await check(`/opt/homebrew/opt/postgresql@${v}/bin`, `Homebrew postgresql@${v}`);
  }
  await check("/opt/homebrew/opt/libpq/bin", "Homebrew libpq");

  // Homebrew (Intel Mac)
  for (const v of versions) {
    await check(`/usr/local/opt/postgresql@${v}/bin`, `Homebrew postgresql@${v}`);
  }
  await check("/usr/local/opt/libpq/bin", "Homebrew libpq");

  // Postgres.app
  for (const v of versions) {
    await check(`/Applications/Postgres.app/Contents/Versions/${v}/bin`, `Postgres.app ${v}`);
  }

  // Debian/Ubuntu versioned paths
  for (const v of versions) {
    await check(`/usr/lib/postgresql/${v}/bin`, `System package postgresql-client-${v}`);
  }

  return found;
}

export async function detectCommand(config: PgdevConfig): Promise<void> {
  const { verbose } = config;
  const s = verbose ? noopSpinner() : spinner("Detecting NpgsqlRest installation...");

  const result = await detectNpgsqlRest(verbose);

  if (verbose) console.log();

  if (result) {
    await updateLocalConfig("tools", "npgsqlrest", result.command);
    s.stop(success(`Found NpgsqlRest v${result.version}`));
    console.log(pc.dim(`  Source: ${result.source}`));
    console.log(info(`Config updated: tools.npgsqlrest = "${result.command}"`));
  } else {
    s.stop(error("No NpgsqlRest installation found"));
    console.log(pc.dim(`  Run ${pc.bold("pgdev setup")} to install it.`));
  }

  // Detect PostgreSQL client tools
  const ps = verbose ? noopSpinner() : spinner("Detecting PostgreSQL client tools...");
  const pgInstalls = await detectPgTools(verbose);

  if (verbose) console.log();

  if (pgInstalls.length === 0) {
    ps.stop(error("No PostgreSQL client tools found"));
    console.log(pc.dim(`  Run ${pc.bold("pgdev setup")} to install them.`));
  } else {
    let chosen: PgInstallation;
    if (pgInstalls.length === 1) {
      chosen = pgInstalls[0];
    } else {
      ps.stop(success(`Found ${pgInstalls.length} PostgreSQL installations`));
      const choice = ask("Which installation should pgdev use?", pgInstalls.map((p) => ({
        label: `v${p.version}`,
        description: p.binDir ? `${p.source} (${p.binDir})` : p.source,
      })));
      chosen = pgInstalls[choice];
    }

    const psqlCmd = chosen.binDir ? `${chosen.binDir}/psql` : "psql";
    const pgDumpCmd = chosen.binDir ? `${chosen.binDir}/pg_dump` : "pg_dump";
    const pgRestoreCmd = chosen.binDir ? `${chosen.binDir}/pg_restore` : "pg_restore";

    await updateLocalConfig("tools", "psql", psqlCmd);
    await updateLocalConfig("tools", "pg_dump", pgDumpCmd);
    await updateLocalConfig("tools", "pg_restore", pgRestoreCmd);

    if (pgInstalls.length === 1) {
      ps.stop(success(`Found PostgreSQL client tools v${chosen.version}`));
      console.log(pc.dim(`  Source: ${chosen.source}`));
    }
    console.log(info(`Config updated: tools.psql = "${psqlCmd}"`));
    console.log(info(`Config updated: tools.pg_dump = "${pgDumpCmd}"`));
    console.log(info(`Config updated: tools.pg_restore = "${pgRestoreCmd}"`));
  }
}
