import { resolve } from "node:path";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PgdevConfig } from "../config.ts";
import { pc, spinner } from "../utils/terminal.ts";
import { findSqlFiles } from "../utils/files.ts";
import { parseRoutines, type ParsedRoutine } from "../parser/routine.ts";
import { fetchCatalogMetadata, type CatalogRoutine } from "../parser/catalog.ts";
import { routinesDiffer, commentsDiffer, grantsDiffer, type DiffOptions } from "../parser/compare.ts";
import { scanProjectFiles } from "../parser/scanner.ts";
import { fetchHistory } from "../parser/history.ts";
import { resolveExecutionPlan } from "../parser/resolver.ts";
import { stripPgdevHeader } from "../parser/header.ts";

export interface DiffFlags {
  script: boolean;
  scriptFile?: string;
}

/**
 * Match key uses schema.name only. Overloaded functions (same name, different
 * params) are grouped and matched by parameter count.
 */
function groupKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

function parsedGroupKey(r: ParsedRoutine, defaultSchema: string): string {
  return groupKey(r.schema ?? defaultSchema, r.name);
}

function catalogGroupKey(r: CatalogRoutine): string {
  return groupKey(r.schema, r.name);
}

function parsedDisplayKey(r: ParsedRoutine, defaultSchema: string): string {
  const schema = r.schema ?? defaultSchema;
  const params = r.parameters.map((p) => p.type.toLowerCase());
  return `${schema}.${r.name}(${params.join(", ")})`;
}

function catalogDisplayKey(r: CatalogRoutine): string {
  const params = r.parameters.map((p) => p.type);
  return `${r.schema}.${r.name}(${params.join(", ")})`;
}

export async function diffCommand(config: PgdevConfig, flags?: DiffFlags): Promise<void> {
  const { project_dir, schemas, grants, ignore_body_whitespace } = config.project;

  if (!project_dir) {
    console.error(pc.red("project_dir is not configured. Run pgdev config to set it."));
    process.exit(1);
  }

  if (schemas.length === 0) {
    console.error(pc.red("No schemas configured. Run pgdev config to set project schemas."));
    process.exit(1);
  }

  const fullDir = resolve(process.cwd(), project_dir);
  let isDir = false;
  try { isDir = statSync(fullDir).isDirectory(); } catch {}
  if (!isDir) {
    console.error(pc.red(`Project directory not found: ${project_dir}`));
    process.exit(1);
  }

  // Parse all SQL files
  const s = spinner("Parsing SQL files...");
  const sqlFiles = findSqlFiles(fullDir);
  if (sqlFiles.length === 0) {
    s.stop();
    console.log(pc.yellow("No .sql files found in " + project_dir));
    return;
  }

  const defaultSchema = schemas[0];

  // Collect parsed routines grouped by schema.name
  // Also keep raw file content for --script (to include the original SQL)
  const parsedGroups = new Map<string, { routine: ParsedRoutine; file: string; display: string; content: string }[]>();
  let totalParsed = 0;

  for (const file of sqlFiles) {
    const content = await Bun.file(file).text();
    const routines = parseRoutines(content, { grants });
    const relPath = file.slice(process.cwd().length + 1);
    for (const r of routines) {
      const gk = parsedGroupKey(r, defaultSchema);
      const dk = parsedDisplayKey(r, defaultSchema);
      let group = parsedGroups.get(gk);
      if (!group) { group = []; parsedGroups.set(gk, group); }
      group.push({ routine: r, file: relPath, display: dk, content });
      totalParsed++;
    }
  }
  s.update("Fetching catalog metadata...");

  // Fetch catalog
  let catalog: CatalogRoutine[];
  try {
    catalog = await fetchCatalogMetadata(config);
  } catch (err) {
    s.stop();
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
  s.stop();

  // Group catalog routines by schema.name
  const catalogGroups = new Map<string, { routine: CatalogRoutine; display: string }[]>();
  for (const c of catalog) {
    const gk = catalogGroupKey(c);
    const dk = catalogDisplayKey(c);
    let group = catalogGroups.get(gk);
    if (!group) { group = []; catalogGroups.set(gk, group); }
    group.push({ routine: c, display: dk });
  }

  // Compare — match by schema.name, then by param count for overloads
  const needCreating: { display: string; file: string; routine: ParsedRoutine; content: string }[] = [];
  const needUpdating: { display: string; file: string; changes: string[]; routine: ParsedRoutine; content: string; catalog: CatalogRoutine }[] = [];
  const needDropping: { display: string; catalog: CatalogRoutine }[] = [];
  const matchedCatalogKeys = new Set<string>();

  for (const [gk, parsedList] of parsedGroups) {
    const catList = catalogGroups.get(gk);
    if (!catList) {
      for (const p of parsedList) needCreating.push({ display: p.display, file: p.file, routine: p.routine, content: p.content });
      continue;
    }

    matchedCatalogKeys.add(gk);

    // Match each parsed routine to a catalog routine by param count
    const usedCat = new Set<number>();
    for (const p of parsedList) {
      const paramCount = p.routine.parameters.length;
      const catIdx = catList.findIndex((c, i) => !usedCat.has(i) && c.routine.parameters.length === paramCount);
      if (catIdx === -1) {
        needCreating.push({ display: p.display, file: p.file, routine: p.routine, content: p.content });
        continue;
      }
      usedCat.add(catIdx);
      const cat = catList[catIdx].routine;

      const changes: string[] = [];
      const diffOpts: DiffOptions = { ignoreBodyWhitespace: ignore_body_whitespace };
      if (routinesDiffer(p.routine, cat, diffOpts)) changes.push("definition");
      if (commentsDiffer(p.routine, cat)) changes.push("comment");
      if (grants && grantsDiffer(p.routine, cat)) changes.push("grants");

      if (changes.length > 0) {
        needUpdating.push({ display: p.display, file: p.file, changes, routine: p.routine, content: p.content, catalog: cat });
      }
    }

    // Unmatched catalog routines in this group
    for (let i = 0; i < catList.length; i++) {
      if (!usedCat.has(i)) needDropping.push({ display: catList[i].display, catalog: catList[i].routine });
    }
  }

  // Catalog routines with no parsed group at all
  for (const [gk, catList] of catalogGroups) {
    if (!matchedCatalogKeys.has(gk)) {
      for (const c of catList) needDropping.push({ display: c.display, catalog: c.routine });
    }
  }

  // Report
  const unchanged = totalParsed - needCreating.length - needUpdating.length;

  if (needCreating.length === 0 && needUpdating.length === 0 && needDropping.length === 0) {
    console.log(pc.green(`All ${totalParsed} routines match the database.`));
    if (flags?.script) console.log(pc.dim("No script generated — nothing to migrate."));
    return;
  }

  console.log();

  if (needCreating.length > 0) {
    console.log(pc.bold(`Missing in database (${needCreating.length}):`));
    for (const { display, file } of needCreating) {
      console.log(`  ${pc.green("+")} ${display}  ${pc.dim(file)}`);
    }
    console.log();
  }

  if (needUpdating.length > 0) {
    console.log(pc.bold(`Different from database (${needUpdating.length}):`));
    for (const { display, file, changes } of needUpdating) {
      console.log(`  ${pc.yellow("~")} ${display}  ${pc.dim(file)}  ${pc.yellow(changes.join(", "))}`);
    }
    console.log();
  }

  if (needDropping.length > 0) {
    console.log(pc.bold(`Only in database (${needDropping.length}):`));
    for (const { display } of needDropping) {
      console.log(`  ${pc.red("-")} ${display}`);
    }
    console.log();
  }

  // Summary
  const parts: string[] = [];
  if (unchanged > 0) parts.push(`${unchanged} unchanged`);
  if (needCreating.length > 0) parts.push(pc.green(`${needCreating.length} to create`));
  if (needUpdating.length > 0) parts.push(pc.yellow(`${needUpdating.length} to update`));
  if (needDropping.length > 0) parts.push(pc.red(`${needDropping.length} to drop`));
  console.log(parts.join(", "));

  // Generate migration script
  if (flags?.script) {
    await generateMigrationScript(config, fullDir, flags);
  }
}

/**
 * Generate a migration script based on the scanner/resolver pipeline.
 * Scans all project files, checks history, resolves execution order,
 * and generates a DO block script.
 */
async function generateMigrationScript(config: PgdevConfig, projectDir: string, flags: DiffFlags): Promise<void> {
  const s2 = spinner("Scanning project files...");

  const scanResult = scanProjectFiles(projectDir, {
    upPrefix: config.project.up_prefix,
    repeatablePrefix: config.project.repeatable_prefix,
    separator: config.project.separator,
  });

  // Show scan warnings
  for (const w of scanResult.warnings) {
    console.log(`  ${pc.yellow("!")} ${w.file}: ${pc.dim(w.message)}`);
  }

  s2.update("Fetching migration history...");

  const histResult = await fetchHistory(config);
  if (!histResult.ok) {
    s2.stop();
    console.error(pc.red(histResult.error));
    return;
  }

  s2.stop();

  const plan = resolveExecutionPlan(scanResult.files, histResult.entries);

  // Show resolver warnings
  for (const w of plan.warnings) {
    console.log(`  ${pc.yellow("!")} ${w.file}: ${pc.dim(w.message)}`);
  }

  if (plan.files.length === 0) {
    console.log(pc.dim("No migration script generated — nothing to execute."));
    return;
  }

  // Report what will be in the script
  console.log(`\n${pc.bold(`Migration plan (${plan.files.length} file${plan.files.length > 1 ? "s" : ""}):`)}`)
  for (const f of plan.files) {
    const typeTag = f.type === "versioned" ? pc.cyan(`v${f.version}`) :
                    f.type === "repeatable" ? pc.magenta("repeatable") :
                    pc.blue("routine");
    const reasonTag = f.reason === "new" ? pc.green("new") :
                      f.reason === "changed" ? pc.yellow("changed") :
                      pc.dim("cascade");
    console.log(`  ${typeTag} ${f.relPath}  ${reasonTag}`);
  }

  // Generate DO block script
  const date = new Date();
  const ident = date.toISOString().replace(/[-:.ZT]/g, "");
  const tag = `$migration_${ident}$`;
  const lines: string[] = [];
  let migrationIdx = 0;

  lines.push("do");
  lines.push(tag);
  lines.push("declare ___clock timestamp with time zone;");
  lines.push("begin");
  lines.push("--");
  lines.push("-- Migration file generated by pgdev");
  lines.push(`-- Date: ${date.toISOString()}`);
  lines.push("--");
  lines.push("");

  for (const file of plan.files) {
    migrationIdx++;
    const sql = stripPgdevHeader(file.content).trim();
    const typeLabel = file.type === "versioned" ? `VERSIONED (v${file.version})` :
                      file.type === "repeatable" ? "REPEATABLE" : "ROUTINE";

    lines.push("--");
    lines.push(`-- Migration ${migrationIdx}`);
    lines.push(`-- Script: ${file.relPath}`);
    lines.push(`-- Type: ${typeLabel}`);
    lines.push(`-- Reason: ${file.reason}`);
    lines.push("--");
    lines.push("___clock = clock_timestamp();");
    lines.push(`-- Migration ${migrationIdx} start`);
    lines.push(sql);
    lines.push(`-- Migration ${migrationIdx} end`);
    lines.push(`raise info 'Migration ${migrationIdx}: ${typeLabel} ${file.relPath} completed in % (${file.reason})', clock_timestamp() - ___clock;`);
    lines.push("");
  }

  lines.push("end;");
  lines.push(`${tag};`);

  const scriptFile = flags.scriptFile
    ? resolve(process.cwd(), flags.scriptFile)
    : resolve(tmpdir(), `migration_${ident}.sql`);
  await Bun.write(scriptFile, lines.join("\n") + "\n");
  console.log(`\n${pc.bold("Migration script:")} ${scriptFile}`);
}
