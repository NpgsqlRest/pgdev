import { resolve } from "node:path";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PgdevConfig } from "../config.ts";
import { pc, spinner } from "../utils/terminal.ts";
import { findSqlFiles } from "../utils/files.ts";
import { parseRoutines, type ParsedRoutine } from "../parser/routine.ts";
import { fetchCatalogMetadata, type CatalogRoutine } from "../parser/catalog.ts";
import { routinesDiffer, commentsDiffer, grantsDiffer, type DiffOptions } from "../parser/compare.ts";
import { formatRoutine, formatComment, formatGrants, qualifiedName, configToFormatOptions } from "../parser/formatter.ts";

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

/** Build qualified name for DROP statements from catalog routine. */
function catalogQualifiedSig(r: CatalogRoutine): string {
  const params = r.parameters.map((p) => p.type).join(", ");
  return `${r.schema}.${r.name}(${params})`;
}

export async function diffCommand(config: PgdevConfig, flags?: DiffFlags): Promise<void> {
  const { routines_dir, schemas, grants, ignore_body_whitespace } = config.project;

  if (!routines_dir) {
    console.error(pc.red("routines_dir is not configured. Run pgdev config to set it."));
    process.exit(1);
  }

  if (schemas.length === 0) {
    console.error(pc.red("No schemas configured. Run pgdev config to set project schemas."));
    process.exit(1);
  }

  const fullDir = resolve(process.cwd(), routines_dir);
  let isDir = false;
  try { isDir = statSync(fullDir).isDirectory(); } catch {}
  if (!isDir) {
    console.error(pc.red(`Routines directory not found: ${routines_dir}`));
    process.exit(1);
  }

  // Parse all SQL files
  const s = spinner("Parsing SQL files...");
  const sqlFiles = findSqlFiles(fullDir);
  if (sqlFiles.length === 0) {
    s.stop();
    console.log(pc.yellow("No .sql files found in " + routines_dir));
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
    const formatOpts = configToFormatOptions(config.format);
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

    // Create new routines
    for (const { file, routine } of needCreating) {
      migrationIdx++;
      const display = parsedDisplayKey(routine, defaultSchema);
      lines.push("--");
      lines.push(`-- Migration ${migrationIdx}`);
      lines.push(`-- Script: ${file}`);
      lines.push(`-- Type: CREATE`);
      lines.push("--");
      lines.push("___clock = clock_timestamp();");
      lines.push(`-- Migration ${migrationIdx} start`);
      lines.push(formatRoutine(routine, formatOpts));
      lines.push(`-- Migration ${migrationIdx} end`);
      lines.push(`raise info 'Migration ${migrationIdx}: CREATE ${display} completed in % (${file})', clock_timestamp() - ___clock;`);
      lines.push("");
    }

    // Update changed routines
    for (const { file, changes, routine } of needUpdating) {
      migrationIdx++;
      const display = parsedDisplayKey(routine, defaultSchema);
      lines.push("--");
      lines.push(`-- Migration ${migrationIdx}`);
      lines.push(`-- Script: ${file}`);
      lines.push(`-- Type: UPDATE (${changes.join(", ")})`);
      lines.push("--");
      lines.push("___clock = clock_timestamp();");
      lines.push(`-- Migration ${migrationIdx} start`);

      if (changes.includes("definition")) {
        lines.push(formatRoutine(routine, { ...formatOpts, createOrReplace: true }));
      }

      if (changes.includes("comment")) {
        const commentSql = formatComment(routine, formatOpts);
        if (commentSql) {
          lines.push(commentSql);
        } else {
          // File has no comment — remove from database
          const kw = (w: string) => formatOpts.lowercase ? w.toLowerCase() : w;
          const typeKw = kw(routine.type === "function" ? "FUNCTION" : "PROCEDURE");
          const qn = qualifiedName(routine);
          const sig = routine.parameters.map((p) => formatOpts.lowercase ? p.type.toLowerCase() : p.type).join(", ");
          lines.push(`${kw("COMMENT ON")} ${typeKw} ${qn}(${sig}) ${kw("IS")} NULL;`);
        }
        lines.push("");
      }

      if (changes.includes("grants")) {
        const grantSql = formatGrants(routine, formatOpts);
        if (grantSql.length > 0) {
          lines.push(grantSql.join("\n"));
          lines.push("");
        }
      }

      lines.push(`-- Migration ${migrationIdx} end`);
      lines.push(`raise info 'Migration ${migrationIdx}: UPDATE ${display} (${changes.join(", ")}) completed in % (${file})', clock_timestamp() - ___clock;`);
      lines.push("");
    }

    // Drop routines only in database
    for (const { catalog: cat } of needDropping) {
      migrationIdx++;
      const typeKw = formatOpts.lowercase ? cat.type : cat.type.toUpperCase();
      const sig = catalogQualifiedSig(cat);
      const dropKw = formatOpts.lowercase ? "drop" : "DROP";
      const ifExistsKw = formatOpts.lowercase ? "if exists" : "IF EXISTS";
      const display = `${cat.schema}.${cat.name}(${cat.parameters.map((p) => p.type).join(", ")})`;

      lines.push("--");
      lines.push(`-- Migration ${migrationIdx}`);
      lines.push(`-- Type: DROP`);
      lines.push("--");
      lines.push("___clock = clock_timestamp();");
      lines.push(`-- Migration ${migrationIdx} start`);
      lines.push(`${dropKw} ${typeKw} ${ifExistsKw} ${sig};`);
      lines.push(`-- Migration ${migrationIdx} end`);
      lines.push(`raise info 'Migration ${migrationIdx}: DROP ${display} completed in %', clock_timestamp() - ___clock;`);
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
}
