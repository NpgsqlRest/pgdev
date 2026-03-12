import { resolve } from "node:path";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { type PgdevConfig } from "../config.ts";
import { resolveConnection } from "./exec.ts";
import { splitCommand } from "../cli.ts";
import { error, success, pc, formatCmd } from "../utils/terminal.ts";
import { findSqlFiles } from "../utils/files.ts";
import { parseRoutines } from "../parser/routine.ts";
import { isApiRoutine, getGroupDir, formatRoutines, configToFormatOptions, DEFAULT_SKIP_PREFIXES } from "../parser/formatter.ts";

function cleanRestoreOutput(sql: string): string {
  return sql
    .split("\n")
    .filter((line) =>
      !/^\\(un)?restrict\b/.test(line) &&
      !/^SET\s+\w+/.test(line) &&
      !/^SELECT\s+pg_catalog\.set_config\b/.test(line) &&
      !/^ALTER\s+(FUNCTION|PROCEDURE)\s+.+\s+OWNER\s+TO\b/.test(line),
    )
    .join("\n");
}

interface RoutineGroup {
  name: string;
  tocLines: string[];
}

export function parseRoutineGroups(tocOutput: string, includeGrants = false): RoutineGroup[] {
  const groups = new Map<string, string[]>();
  const groupOrder: string[] = [];

  for (const line of tocOutput.split("\n")) {
    if (line.startsWith(";") || !line.trim()) continue;

    // Routine definition: "1290; 1255 586699 FUNCTION mathmodule auth_login(...) legendea"
    const routineMatch = line.match(/^\d+;\s+1255\s+\d+\s+(?:FUNCTION|PROCEDURE)\s+\S+\s+(\S+)\(/);
    if (routineMatch) {
      const name = routineMatch[1];
      if (!groups.has(name)) {
        groups.set(name, []);
        groupOrder.push(name);
      }
      groups.get(name)!.push(line);
      continue;
    }

    // COMMENT on routine: "5801; 0 0 COMMENT mathmodule FUNCTION auth_login(...) legendea"
    const commentMatch = line.match(/^\d+;\s+0\s+0\s+COMMENT\s+\S+\s+(?:FUNCTION|PROCEDURE)\s+(\S+)\(/);
    if (commentMatch) {
      const name = commentMatch[1];
      groups.get(name)?.push(line);
      continue;
    }

    // ACL on routine: "5800; 0 0 ACL mathmodule FUNCTION auth_login(...) legendea"
    if (includeGrants) {
      const aclMatch = line.match(/^\d+;\s+0\s+0\s+ACL\s+\S+\s+(?:FUNCTION|PROCEDURE)\s+(\S+)\(/);
      if (aclMatch) {
        const name = aclMatch[1];
        groups.get(name)?.push(line);
      }
    }
  }

  return groupOrder.map((name) => ({ name, tocLines: groups.get(name)! }));
}

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
      .filter((line) => !/\bFUNCTION\b|\bPROCEDURE\b/.test(line))
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

      const cleaned = cleanRestoreOutput(restoreStdout);

      const outPath = resolve(fullDir, "schema.sql");
      if (existsSync(outPath)) {
        console.log(pc.dim(`Schema file already exists: ${outPath} (skipped)`));
      } else {
        await Bun.write(outPath, cleaned);
        console.log(success(`Schema written to ${pc.bold(outPath)}`));
      }
    } finally {
      try { unlinkSync(tocFile); } catch {}
    }

    // Step 4: Extract routines to individual files
    const routinesDir = config.project.routines_dir;
    if (routinesDir) {
      const fullRoutinesDir = resolve(process.cwd(), routinesDir);
      mkdirSync(fullRoutinesDir, { recursive: true });

      // Scan existing files to map routine names to file paths
      const existingRoutines = new Map<string, { file: string; content: string }>();
      const existingFiles = findSqlFiles(fullRoutinesDir);
      for (const file of existingFiles) {
        const content = await Bun.file(file).text();
        const parsed = parseRoutines(content);
        for (const r of parsed) {
          existingRoutines.set(r.name, { file, content });
        }
      }

      const routineGroups = parseRoutineGroups(listStdout, config.project.grants);

      if (routineGroups.length > 0) {
        const routineTocFile = resolve(tmpdir(), `pgdev-routine-toc-${Date.now()}.list`);
        try {
          let created = 0;
          let updated = 0;
          let unchanged = 0;
          for (const group of routineGroups) {
            await Bun.write(routineTocFile, group.tocLines.join("\n") + "\n");

            const rCmd = [...pgRestoreParts, "-L", routineTocFile, "-f", "-", dumpFile];

            if (config.verbose) {
              console.error(pc.cyan(formatCmd(rCmd)));
            }

            const rProc = Bun.spawn(rCmd, { stdout: "pipe", stderr: "pipe", env });
            const [rStdout, rStderr, rExit] = await Promise.all([
              new Response(rProc.stdout).text(),
              new Response(rProc.stderr).text(),
              rProc.exited,
            ]);

            if (rExit !== 0) {
              console.error(error(`pg_restore failed for ${group.name}: ${rStderr.trim()}`));
              continue;
            }

            const cleaned = cleanRestoreOutput(rStdout);
            const formatOpts = configToFormatOptions(config.format);
            const parsed = parseRoutines(cleaned, { grants: config.project.grants });
            const routineSql = parsed.length > 0 ? formatRoutines(parsed, formatOpts) : cleaned;
            const existing = existingRoutines.get(group.name);

            if (existing && existing.content.trimEnd() === routineSql.trimEnd()) {
              // Content identical — skip
              unchanged++;
              if (config.verbose) {
                console.error(pc.dim(`  ${group.name} (unchanged)`));
              }
              continue;
            }

            // Write to existing file path if routine exists, otherwise new file
            let outFile: string;
            if (existing) {
              outFile = existing.file;
            } else {
              // Determine base dir: api_dir or internal_dir if configured
              const isApi = isApiRoutine(parsed);
              const typeSubDir = isApi ? config.project.api_dir : config.project.internal_dir;

              // Determine group dir from name segment
              const skipSet = new Set(config.project.skip_prefixes.length > 0 ? config.project.skip_prefixes : DEFAULT_SKIP_PREFIXES);
              const groupSubDir = getGroupDir(
                group.name,
                config.project.group_segment,
                skipSet,
              );

              let targetDir = fullRoutinesDir;
              if (config.project.group_order === "group_first") {
                if (groupSubDir) targetDir = resolve(targetDir, groupSubDir);
                if (typeSubDir) targetDir = resolve(targetDir, typeSubDir);
              } else {
                if (typeSubDir) targetDir = resolve(targetDir, typeSubDir);
                if (groupSubDir) targetDir = resolve(targetDir, groupSubDir);
              }
              if (targetDir !== fullRoutinesDir) mkdirSync(targetDir, { recursive: true });
              outFile = resolve(targetDir, `${group.name}.sql`);
            }
            await Bun.write(outFile, routineSql);

            if (existing) {
              updated++;
              if (config.verbose) {
                console.error(pc.yellow(`  ${group.name} (updated)`));
              }
            } else {
              created++;
              if (config.verbose) {
                console.error(pc.green(`  ${group.name} (created)`));
              }
            }
          }

          const parts: string[] = [];
          if (created > 0) parts.push(pc.green(`${created} created`));
          if (updated > 0) parts.push(pc.yellow(`${updated} updated`));
          if (unchanged > 0) parts.push(`${unchanged} unchanged`);
          console.log(success(`Routines in ${pc.bold(routinesDir + "/")}: ${parts.join(", ")}`));
        } finally {
          try { unlinkSync(routineTocFile); } catch {}
        }
      }
    }
  } finally {
    try { unlinkSync(dumpFile); } catch {}
  }
}
