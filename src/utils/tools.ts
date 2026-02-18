import { $ } from "bun";
import { logCommand, type Spinner } from "./terminal.ts";

export interface Detection {
  command: string;
  version: string;
  source: string;
}

export interface PgInstallation {
  binDir: string | null; // null = bare commands on PATH
  version: string;
  source: string;
}

/** No-op spinner — prints final result line only. Used by setup/install commands. */
export function noopSpinner(): Spinner {
  return {
    stop(finalText?: string) {
      if (finalText) process.stderr.write(`${finalText}\n`);
    },
    update() {},
    pause() {},
    resume() {},
  };
}

export async function tryNpgsqlRest(command: string, verbose: boolean): Promise<string | null> {
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

export async function detectNpgsqlRest(verbose: boolean): Promise<Detection | null> {
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

  // 4. Check docker — try platform-appropriate tags
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

export async function verifyPgTool(command: string): Promise<string | null> {
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

export async function verifyNpgsqlRest(command: string): Promise<string | null> {
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

export async function detectPgTools(verbose: boolean): Promise<PgInstallation[]> {
  const found: PgInstallation[] = [];
  const seen = new Set<string>();

  async function check(binDir: string, source: string): Promise<void> {
    const psqlPath = `${binDir}/psql`;
    if (seen.has(psqlPath)) return;
    seen.add(psqlPath);

    if (verbose) logCommand([psqlPath, "--version"]);
    const version = await verifyPgTool(psqlPath);
    if (version) {
      found.push({ binDir, version, source });
    }
  }

  // 1. Check bare psql on PATH first
  if (verbose) logCommand(["psql", "--version"]);
  const pathVersion = await verifyPgTool("psql");
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
