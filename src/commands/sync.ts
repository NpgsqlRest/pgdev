import { resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { type PgdevConfig } from "../config.ts";
import { resolveConnection } from "./exec.ts";
import { splitCommand } from "../cli.ts";
import { error, success, pc, formatCmd } from "../utils/terminal.ts";

export async function syncCommand(config: PgdevConfig): Promise<void> {
  const migrationsDir = config.project.migrations_dir;
  if (!migrationsDir) {
    console.error(error("No migrations_dir configured. Run pgdev config to set it up."));
    process.exit(1);
  }

  const fullDir = resolve(process.cwd(), migrationsDir);
  if (!existsSync(fullDir)) {
    console.error(error(`migrations_dir does not exist: ${fullDir}`));
    process.exit(1);
  }

  const schemas = config.project.schemas ?? [];

  const fields = await resolveConnection(config);
  if (typeof fields === "string") {
    console.error(error(fields));
    process.exit(1);
  }
  if (!fields.database) {
    console.error(error("No database specified in connection."));
    process.exit(1);
  }

  const env = { ...process.env, PGPASSWORD: fields.password };
  const connArgs = ["-h", fields.host, "-p", fields.port, "-d", fields.database, "-U", fields.username];
  const schemaArgs = schemas.flatMap((s) => ["-n", s]);

  // Step 1: pg_dump to custom format (temp file)
  const dumpFile = resolve(tmpdir(), `pgdev-schema-${Date.now()}.dump`);
  const pgDumpParts = splitCommand(config.tools.pg_dump);
  const dumpCmd = [...pgDumpParts, "-Fc", "--schema-only", "--no-owner", ...connArgs, ...schemaArgs, "-f", dumpFile];

  if (config.verbose) {
    console.error(pc.cyan(formatCmd(dumpCmd)));
  }

  const dumpProc = Bun.spawn(dumpCmd, { stdout: "pipe", stderr: "pipe", env });
  const [, dumpStderr, dumpExit] = await Promise.all([
    new Response(dumpProc.stdout).text(),
    new Response(dumpProc.stderr).text(),
    dumpProc.exited,
  ]);

  if (dumpExit !== 0) {
    console.error(error(dumpStderr.trim() || `pg_dump exited with code ${dumpExit}`));
    process.exit(dumpExit);
  }

  try {
    // Step 2: pg_restore -l to get TOC, then filter out FUNCTION/PROCEDURE/AGGREGATE
    const pgRestoreParts = splitCommand(config.tools.pg_restore);
    const listCmd = [...pgRestoreParts, "-l", dumpFile];

    if (config.verbose) {
      console.error(pc.cyan(formatCmd(listCmd)));
    }

    const listProc = Bun.spawn(listCmd, { stdout: "pipe", stderr: "pipe", env });
    const [listStdout, listStderr, listExit] = await Promise.all([
      new Response(listProc.stdout).text(),
      new Response(listProc.stderr).text(),
      listProc.exited,
    ]);

    if (listExit !== 0) {
      console.error(error(listStderr.trim() || `pg_restore -l exited with code ${listExit}`));
      process.exit(listExit);
    }

    const filteredToc = listStdout
      .split("\n")
      .filter((line) => !/\bFUNCTION\b|\bPROCEDURE\b|\bAGGREGATE\b/.test(line))
      .join("\n");

    const tocFile = resolve(tmpdir(), `pgdev-toc-${Date.now()}.list`);
    await Bun.write(tocFile, filteredToc);

    try {
      // Step 3: pg_restore with filtered TOC to produce SQL
      const restoreCmd = [...pgRestoreParts, "-L", tocFile, "-f", "-", dumpFile];

      if (config.verbose) {
        console.error(pc.cyan(formatCmd(restoreCmd)));
      }

      const restoreProc = Bun.spawn(restoreCmd, { stdout: "pipe", stderr: "pipe", env });
      const [restoreStdout, restoreStderr, restoreExit] = await Promise.all([
        new Response(restoreProc.stdout).text(),
        new Response(restoreProc.stderr).text(),
        restoreProc.exited,
      ]);

      if (restoreExit !== 0) {
        console.error(error(restoreStderr.trim() || `pg_restore exited with code ${restoreExit}`));
        process.exit(restoreExit);
      }

      const cleaned = restoreStdout
        .split("\n")
        .filter((line) =>
          !/^\\(un)?restrict\b/.test(line) &&
          !/^SET\s+\w+/.test(line) &&
          !/^SELECT\s+pg_catalog\.set_config\b/.test(line),
        )
        .join("\n");

      const outPath = resolve(fullDir, "schema.sql");
      await Bun.write(outPath, cleaned);
      console.log(success(`Schema written to ${pc.bold(outPath)}`));
    } finally {
      try { unlinkSync(tocFile); } catch {}
    }
  } finally {
    try { unlinkSync(dumpFile); } catch {}
  }
}
