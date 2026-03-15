import { resolve } from "node:path";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { type PgdevConfig, updateConfigArray } from "../config.ts";
import { resolveConnection } from "./exec.ts";
import { splitCommand } from "../cli.ts";
import { error, success, pc, formatCmd } from "../utils/terminal.ts";
import { findSqlFiles } from "../utils/files.ts";
import { parseRoutines, unquoteIdent } from "../parser/routine.ts";
import { isApiRoutine, getGroupDir, formatRoutines, configToFormatOptions, DEFAULT_SKIP_PREFIXES } from "../parser/formatter.ts";
import { fetchCatalogMetadata, type CatalogRoutine } from "../parser/catalog.ts";
import { commentsDiffer, parsedRoutinesDiffer } from "../parser/compare.ts";
import { applyCommentFixes, applyBodyFixes, applyGrantFixes, removeComments } from "../parser/fix.ts";
import type { ParsedRoutine } from "../parser/routine.ts";
import { bodyHash } from "../parser/catalog.ts";

type SyncAction = "yes" | "no" | "never" | "all" | "all-create" | "all-update" | "quit";

/**
 * Prompt user for sync action.
 * Ctrl+C / null input → quit.
 */
function askSyncAction(): SyncAction {
  const input = prompt(`  ${pc.dim("[Y]es / [n]o / [N]ever / [a]ll / [c]reate all / [u]pdate all / [q]uit")}`);
  if (input === null) return "quit"; // Ctrl+C or Ctrl+D
  const answer = input.trim().toLowerCase();
  if (answer === "" || answer === "y" || answer === "yes") return "yes";
  if (answer === "n" || answer === "no") return "no";
  if (answer.startsWith("ne") || answer === "never") return "never";
  if (answer === "a" || answer === "all") return "all";
  if (answer === "c" || answer === "create all") return "all-create";
  if (answer === "u" || answer === "update all") return "all-update";
  if (answer === "q" || answer === "quit") return "quit";
  return "yes"; // default
}

export interface SyncFlags {
  comments: boolean;
  grants: boolean;
  definitions: boolean;
  format: boolean;
  force: boolean;
}

function cleanRestoreOutput(sql: string): string {
  return sql
    .split("\n")
    .filter((line) =>
      !/^\\(un)?restrict\b/.test(line) &&
      !/^SET\s+\w+/.test(line) &&
      !/^SELECT\s+pg_catalog\.set_config\b/.test(line) &&
      !/^ALTER\s+(FUNCTION|PROCEDURE|VIEW|AGGREGATE)\s+.+\s+OWNER\s+TO\b/.test(line),
    )
    .join("\n");
}

export interface RoutineGroup {
  name: string;
  schema: string;
  routineType: string;
  tocLines: string[];
}

/** Supported routine_types values. */
export const SUPPORTED_ROUTINE_TYPES = ["FUNCTION", "PROCEDURE", "AGGREGATE", "VIEW"];

export function parseRoutineGroups(
  tocOutput: string,
  options: { includeGrants?: boolean; routineTypes?: string[] } = {},
): RoutineGroup[] {
  const { includeGrants = false, routineTypes = ["FUNCTION", "PROCEDURE"] } = options;
  const typePattern = routineTypes.join("|");

  // Definition: "1290; 1255 586699 FUNCTION schema name(...) owner"
  // or for VIEW: "1290; 1259 586699 VIEW schema view_name owner"
  // (\S+?) with lazy match stops at ( or whitespace — works for both.
  const routineRe = new RegExp(
    `^\\d+;\\s+\\d+\\s+\\d+\\s+(${typePattern})\\s+(\\S+)\\s+(\\S+?)(?:\\(|\\s)`,
  );
  // COMMENT: "5801; 0 0 COMMENT schema FUNCTION name(...) owner"
  // or: "5801; 0 0 COMMENT schema VIEW view_name owner"
  const commentRe = new RegExp(
    `^\\d+;\\s+0\\s+0\\s+COMMENT\\s+\\S+\\s+(?:${typePattern})\\s+(\\S+?)(?:\\(|\\s)`,
  );
  // ACL: "5800; 0 0 ACL schema FUNCTION name(...) owner"
  const aclRe = new RegExp(
    `^\\d+;\\s+0\\s+0\\s+ACL\\s+\\S+\\s+(?:${typePattern})\\s+(\\S+?)(?:\\(|\\s)`,
  );

  const groups = new Map<string, RoutineGroup>();
  const groupOrder: string[] = [];

  for (const line of tocOutput.split("\n")) {
    if (line.startsWith(";") || !line.trim()) continue;

    const routineMatch = line.match(routineRe);
    if (routineMatch) {
      const [, routineType, schema, name] = routineMatch;
      if (!groups.has(name)) {
        groups.set(name, { name, schema, routineType: routineType.toLowerCase(), tocLines: [] });
        groupOrder.push(name);
      }
      groups.get(name)!.tocLines.push(line);
      continue;
    }

    const commentMatch = line.match(commentRe);
    if (commentMatch) {
      groups.get(commentMatch[1])?.tocLines.push(line);
      continue;
    }

    if (includeGrants) {
      const aclMatch = line.match(aclRe);
      if (aclMatch) {
        groups.get(aclMatch[1])?.tocLines.push(line);
      }
    }
  }

  return groupOrder.map((name) => groups.get(name)!);
}

/**
 * Selective sync: update only comments (or grants) in existing source files
 * by comparing parsed routines against the database catalog.
 */
async function selectiveSync(config: PgdevConfig, flags: SyncFlags): Promise<void> {
  const { routines_dir, schemas, grants } = config.project;

  if (!routines_dir) {
    console.error(error("No routines_dir configured. Run pgdev config to set it up."));
    process.exit(1);
  }

  if (schemas.length === 0) {
    console.error(error("No schemas configured. Run pgdev config to set project schemas."));
    process.exit(1);
  }

  const fullDir = resolve(process.cwd(), routines_dir);
  if (!existsSync(fullDir)) {
    console.error(error(`Routines directory not found: ${routines_dir}`));
    process.exit(1);
  }

  const sqlFiles = findSqlFiles(fullDir);
  if (sqlFiles.length === 0) {
    console.log(pc.yellow("No .sql files found in " + routines_dir));
    return;
  }

  const defaultSchema = schemas[0];

  // Parse all SQL files
  const fileRoutines = new Map<string, { routine: ParsedRoutine; relPath: string }[]>();
  for (const file of sqlFiles) {
    const content = await Bun.file(file).text();
    const routines = parseRoutines(content, { grants });
    const relPath = file.slice(process.cwd().length + 1);
    for (const r of routines) {
      const key = `${r.schema ?? defaultSchema}.${r.name}`;
      let list = fileRoutines.get(key);
      if (!list) { list = []; fileRoutines.set(key, list); }
      list.push({ routine: r, relPath });
    }
  }

  // Fetch catalog
  let catalog: CatalogRoutine[];
  try {
    catalog = await fetchCatalogMetadata(config);
  } catch (err) {
    console.error(error(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  // Match and collect fixes grouped by absolute file path
  const commentFixesByFile = new Map<string, { routine: ParsedRoutine; catalogComment: string }[]>();

  for (const cat of catalog) {
    const key = `${cat.schema}.${cat.name}`;
    const parsedList = fileRoutines.get(key);
    if (!parsedList) continue;

    // Match by param count
    const match = parsedList.find((p) => p.routine.parameters.length === cat.parameters.length);
    if (!match) continue;

    if (flags.comments && commentsDiffer(match.routine, cat) && cat.comment != null) {
      const absFile = resolve(process.cwd(), match.relPath);
      let list = commentFixesByFile.get(absFile);
      if (!list) { list = []; commentFixesByFile.set(absFile, list); }
      list.push({ routine: match.routine, catalogComment: cat.comment });
    }
  }

  // Apply comment fixes
  if (flags.comments) {
    if (commentFixesByFile.size === 0) {
      console.log(pc.dim("No comment differences to sync."));
      return;
    }

    const formatOpts = configToFormatOptions(config.format);
    let totalFixed = 0;
    for (const [absFile, fixes] of commentFixesByFile) {
      const content = await Bun.file(absFile).text();
      const { content: updated, count } = applyCommentFixes(content, fixes, formatOpts);
      if (count > 0) {
        await Bun.write(absFile, updated);
        const relPath = absFile.slice(process.cwd().length + 1);
        console.log(`  ${pc.green("✓")} ${relPath}  ${pc.dim(`${count} comment${count > 1 ? "s" : ""}`)}`);
        totalFixed += count;
      }
    }
    if (totalFixed > 0) {
      console.log(success(`Synced ${totalFixed} comment${totalFixed > 1 ? "s" : ""}.`));
    }
  }

  if (flags.grants) {
    console.log(pc.yellow("--grants sync is not yet implemented."));
  }
  if (flags.definitions) {
    console.log(pc.yellow("--definitions sync is not yet implemented."));
  }
}

export async function syncCommand(config: PgdevConfig, flags?: SyncFlags): Promise<void> {
  // Selective sync mode — only update specific aspects of existing files
  if (flags?.comments || flags?.grants || flags?.definitions) {
    if (flags.format) {
      console.error(pc.yellow("Warning: --format is ignored when using --comments, --grants, or --definitions."));
    }
    return selectiveSync(config, flags);
  }

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

  // Validate routine_types
  const unsupported = config.project.routine_types.filter((t) => !SUPPORTED_ROUTINE_TYPES.includes(t));
  if (unsupported.length > 0) {
    console.error(error(`Unsupported routine_types: ${unsupported.join(", ")}. Supported: ${SUPPORTED_ROUTINE_TYPES.join(", ")}`));
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

    // Filter out configured routine types from schema.sql TOC
    const routineTypeFilterRe = config.project.routine_types.length > 0
      ? new RegExp(`\\b(?:${config.project.routine_types.join("|")})\\b`)
      : null;
    const filteredToc = listStdout
      .split("\n")
      .filter((line) => !routineTypeFilterRe || !routineTypeFilterRe.test(line))
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
      // Warn about group_order dimensions with missing config
      const groupOrder = config.project.group_order;
      if (groupOrder.includes("type") && !config.project.api_dir && !config.project.internal_dir) {
        console.error(pc.yellow(`Warning: group_order includes "type" but api_dir and internal_dir are both empty — "type" dimension will have no effect.`));
      }
      if (groupOrder.includes("name") && config.project.group_segment <= 0) {
        console.error(pc.yellow(`Warning: group_order includes "name" but group_segment is 0 (disabled) — "name" dimension will have no effect.`));
      }
      const fullRoutinesDir = resolve(process.cwd(), routinesDir);
      mkdirSync(fullRoutinesDir, { recursive: true });

      // Scan existing files to map routine names to file paths
      const existingRoutines = new Map<string, { file: string; content: string }>();
      const existingFiles = findSqlFiles(fullRoutinesDir);
      for (const file of existingFiles) {
        const content = await Bun.file(file).text();
        const parsed = parseRoutines(content);
        if (parsed.length > 0) {
          for (const r of parsed) {
            existingRoutines.set(r.name, { file, content });
          }
        } else {
          // Non-parseable files (e.g. VIEWs) — index by filename stem
          const stem = file.split("/").pop()!.replace(/\.sql$/i, "");
          existingRoutines.set(stem, { file, content });
        }
      }

      const routineTypes = config.project.routine_types;
      const routineGroups = parseRoutineGroups(listStdout, {
        includeGrants: config.project.grants,
        routineTypes,
      });

      if (routineGroups.length > 0) {
        const routineTocFile = resolve(tmpdir(), `pgdev-routine-toc-${Date.now()}.list`);
        try {
          const formatOpts = configToFormatOptions(config.format);

          // Collect original file contents for unchanged comparison
          const existingFileContents = new Map<string, string>();
          for (const file of existingFiles) {
            existingFileContents.set(file, await Bun.file(file).text());
          }

          // First pass: extract each routine and group by target file
          const forceFormat = flags?.format ?? false;
          const fileRoutines = new Map<string, { sqls: string[]; parsed: ParsedRoutine[]; isNew: boolean }>();

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
            const parsed = parseRoutines(cleaned, { grants: config.project.grants });
            const routineSql = parsed.length > 0 ? formatRoutines(parsed, formatOpts) : cleaned;
            const bareName = unquoteIdent(group.name).bare;
            const existing = existingRoutines.get(bareName);

            // Determine target file
            let outFile: string;
            let isNew: boolean;
            if (existing) {
              outFile = existing.file;
              isNew = false;
            } else {
              // Build target directory from group_order dimensions
              let targetDir = fullRoutinesDir;
              for (const dim of config.project.group_order) {
                let subDir = "";
                if (dim === "type") {
                  const isApi = isApiRoutine(parsed);
                  subDir = isApi ? config.project.api_dir : config.project.internal_dir;
                } else if (dim === "schema") {
                  subDir = unquoteIdent(group.schema).bare;
                } else if (dim === "name") {
                  const skipSet = new Set(config.project.skip_prefixes.length > 0 ? config.project.skip_prefixes : DEFAULT_SKIP_PREFIXES);
                  subDir = getGroupDir(bareName, config.project.group_segment, skipSet);
                } else if (dim === "kind") {
                  subDir = group.routineType;
                }
                if (subDir) targetDir = resolve(targetDir, subDir);
              }
              if (targetDir !== fullRoutinesDir) mkdirSync(targetDir, { recursive: true });
              outFile = resolve(targetDir, `${bareName}.sql`);
              isNew = true;
            }

            // Collect routine SQL and parsed data by target file
            let entry = fileRoutines.get(outFile);
            if (!entry) {
              entry = { sqls: [], parsed: [], isNew };
              fileRoutines.set(outFile, entry);
            }
            entry.sqls.push(routineSql);
            entry.parsed.push(...parsed);
          }

          // Second pass: determine changes, prompt interactively, write
          let created = 0;
          let updated = 0;
          let unchanged = 0;
          let skipped = 0;
          let aborted = false;
          const interactive = !(flags?.force);
          let autoCreate = false;  // auto-approve all creates
          let autoUpdate = false;  // auto-approve all updates
          const syncSkip = new Set(config.project.sync_skip);
          const newSkips: string[] = [];

          for (const [outFile, { sqls, parsed: dbParsed, isNew }] of fileRoutines) {
            const combined = sqls.join("\n");
            const relPath = outFile.slice(process.cwd().length + 1);
            const originalContent = existingFileContents.get(outFile);

            // Check sync_skip list
            if (syncSkip.has(relPath)) {
              skipped++;
              if (config.verbose) {
                console.error(pc.dim(`  ${relPath} (skipped — in sync_skip)`));
              }
              continue;
            }

            // Determine if file needs writing and describe changes
            if (originalContent != null) {
              if (forceFormat) {
                if (originalContent.trimEnd() === combined.trimEnd()) {
                  unchanged++;
                  if (config.verbose) {
                    console.error(pc.dim(`  ${relPath} (unchanged)`));
                  }
                  continue;
                }
              } else {
                const fileParsed = parseRoutines(originalContent, { grants: config.project.grants });
                if (fileParsed.length === dbParsed.length) {
                  let allMatch = true;
                  for (let i = 0; i < fileParsed.length; i++) {
                    if (parsedRoutinesDiffer(fileParsed[i], dbParsed[i], { ignoreBodyWhitespace: config.project.ignore_body_whitespace })) {
                      allMatch = false;
                      break;
                    }
                  }
                  if (allMatch) {
                    unchanged++;
                    if (config.verbose) {
                      console.error(pc.dim(`  ${relPath} (unchanged)`));
                    }
                    continue;
                  }
                }
              }
            }

            // Build change description and prompt
            if (interactive && !(isNew && autoCreate) && !(!isNew && autoUpdate)) {
              if (isNew) {
                console.log(`\n${pc.green("CREATE")} ${pc.bold(relPath)}`);
                for (const r of dbParsed) {
                  const qual = r.schema ? `${r.schema}.${r.name}` : r.name;
                  console.log(`  ${pc.green("+")} ${qual}  ${pc.dim(`[${r.type}]`)}`);
                }
              } else {
                console.log(`\n${pc.yellow("UPDATE")} ${pc.bold(relPath)}`);
                const fileParsed = parseRoutines(originalContent!, { grants: config.project.grants });
                for (const dbr of dbParsed) {
                  const qual = dbr.schema ? `${dbr.schema}.${dbr.name}` : dbr.name;
                  const match = fileParsed.find((fp) => fp.name === dbr.name && fp.schema === dbr.schema);
                  if (!match) {
                    console.log(`  ${pc.green("+")} ${qual}  ${pc.dim("[new routine]")}`);
                  } else {
                    const changes: string[] = [];
                    if (parsedRoutinesDiffer(
                      { ...match, comment: null, grants: [] },
                      { ...dbr, comment: null, grants: [] },
                      { ignoreBodyWhitespace: config.project.ignore_body_whitespace },
                    )) {
                      changes.push("definition");
                    }
                    if ((match.comment ?? null) !== (dbr.comment ?? null)) {
                      changes.push("comment");
                    }
                    if (match.grants.length !== dbr.grants.length ||
                        match.grants.some((g, i) =>
                          g.privilege !== dbr.grants[i]?.privilege ||
                          g.grantee !== dbr.grants[i]?.grantee ||
                          g.isGrant !== dbr.grants[i]?.isGrant)) {
                      changes.push("grants");
                    }
                    if (changes.length > 0) {
                      console.log(`  ${pc.yellow("~")} ${qual}  ${pc.dim(`[${changes.join(", ")}]`)}`);
                    }
                  }
                  if (forceFormat) {
                    console.log(`  ${pc.dim("  (reformatting)")}`);
                  }
                }
              }

              const action = askSyncAction();
              if (action === "quit") {
                aborted = true;
                break;
              }
              if (action === "never") {
                skipped++;
                newSkips.push(relPath);
                console.log(pc.dim(`  → Added to sync_skip`));
                continue;
              }
              if (action === "no") {
                skipped++;
                continue;
              }
              if (action === "all") {
                autoCreate = true;
                autoUpdate = true;
              } else if (action === "all-create") {
                autoCreate = true;
              } else if (action === "all-update") {
                autoUpdate = true;
              }
            }

            if (isNew || forceFormat) {
              // New file or --format: write full formatted output
              await Bun.write(outFile, combined);
            } else {
              // Existing file: apply surgical patches per routine
              let patched = originalContent!;
              const fileParsed = parseRoutines(patched, { grants: config.project.grants });

              const bodyFixes: { routine: ParsedRoutine; catalogBody: string }[] = [];
              const commentFixes: { routine: ParsedRoutine; catalogComment: string }[] = [];
              const commentRemovals: ParsedRoutine[] = [];
              const grantFixes: { routine: ParsedRoutine; catalogGrants: ParsedRoutine["grants"] }[] = [];

              for (const dbr of dbParsed) {
                const match = fileParsed.find((fp) => fp.name === dbr.name && fp.schema === dbr.schema);
                if (!match) continue; // new routine in file — can't patch surgically

                // Body
                if (dbr.body != null && match.body != null) {
                  const ignoreWs = config.project.ignore_body_whitespace;
                  if (bodyHash(match.body, ignoreWs) !== bodyHash(dbr.body, ignoreWs)) {
                    bodyFixes.push({ routine: match, catalogBody: dbr.body });
                  }
                }

                // Comment
                if ((match.comment ?? null) !== (dbr.comment ?? null)) {
                  if (dbr.comment != null) {
                    commentFixes.push({ routine: match, catalogComment: dbr.comment });
                  } else {
                    commentRemovals.push(match);
                  }
                }

                // Grants
                if (config.project.grants) {
                  const grantsDiff = match.grants.length !== dbr.grants.length ||
                    match.grants.some((g, i) =>
                      g.privilege !== dbr.grants[i]?.privilege ||
                      g.grantee !== dbr.grants[i]?.grantee ||
                      g.isGrant !== dbr.grants[i]?.isGrant);
                  if (grantsDiff) {
                    grantFixes.push({ routine: match, catalogGrants: dbr.grants });
                  }
                }
              }

              // Check for routines in DB but not in file (can't patch, need full write)
              const hasNewRoutines = dbParsed.some((dbr) =>
                !fileParsed.find((fp) => fp.name === dbr.name && fp.schema === dbr.schema));

              if (hasNewRoutines) {
                // Fall back to full write for files with new routines
                await Bun.write(outFile, combined);
              } else {
                // Apply surgical patches
                if (bodyFixes.length > 0) {
                  const r = applyBodyFixes(patched, bodyFixes);
                  patched = r.content;
                }
                if (commentRemovals.length > 0) {
                  const r = removeComments(patched, commentRemovals);
                  patched = r.content;
                }
                if (commentFixes.length > 0) {
                  const r = applyCommentFixes(patched, commentFixes, formatOpts);
                  patched = r.content;
                }
                if (grantFixes.length > 0) {
                  const r = applyGrantFixes(patched, grantFixes, formatOpts);
                  patched = r.content;
                }
                if (patched !== originalContent) {
                  await Bun.write(outFile, patched);
                }
              }
            }

            if (isNew) {
              created++;
              if (!interactive && config.verbose) {
                console.error(pc.green(`  ${relPath} (created)`));
              }
            } else {
              updated++;
              if (!interactive && config.verbose) {
                console.error(pc.yellow(`  ${relPath} (updated)`));
              }
            }
          }

          // Persist new sync_skip entries
          if (newSkips.length > 0) {
            const allSkips = [...config.project.sync_skip, ...newSkips];
            await updateConfigArray("project", "sync_skip", allSkips);
          }

          if (aborted) {
            console.log(pc.yellow("\nSync aborted."));
          }

          const parts: string[] = [];
          if (created > 0) parts.push(pc.green(`${created} created`));
          if (updated > 0) parts.push(pc.yellow(`${updated} updated`));
          if (unchanged > 0) parts.push(`${unchanged} unchanged`);
          if (skipped > 0) parts.push(pc.dim(`${skipped} skipped`));
          if (parts.length > 0) {
            console.log(success(`Routines in ${pc.bold(routinesDir + "/")}: ${parts.join(", ")}`));
          }
        } finally {
          try { unlinkSync(routineTocFile); } catch {}
        }
      }
    }
  } finally {
    try { unlinkSync(dumpFile); } catch {}
  }
}
