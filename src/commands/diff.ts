import { resolve } from "node:path";
import { statSync } from "node:fs";
import type { PgdevConfig } from "../config.ts";
import { pc, spinner } from "../utils/terminal.ts";
import { findSqlFiles } from "../utils/files.ts";
import { parseRoutines, type ParsedRoutine, quoteIdent } from "../parser/routine.ts";
import { fetchCatalogMetadata, type CatalogRoutine } from "../parser/catalog.ts";
import { routinesDiffer, commentsDiffer, grantsDiffer, type DiffOptions } from "../parser/compare.ts";
import { formatComment, configToFormatOptions, type FormatOptions } from "../parser/formatter.ts";

export interface FixFlags {
  comments: boolean;
  grants: boolean;
  definitions: boolean;
}

/**
 * Match key uses schema.name only. Overloaded functions (same name, different
 * params) are grouped and matched by parameter count.
 */
function groupKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

/** Display key includes full parameter signature (name + type). */
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

/** Build a regex that matches an existing COMMENT ON for a routine. */
function buildCommentOnRegex(r: ParsedRoutine): RegExp {
  const typeKw = `(?:FUNCTION|PROCEDURE)`;
  const schema = r.schema ? `(?:${escapeRegex(quoteIdent(r.schema, r.schemaQuoted ?? false))}|${escapeRegex(r.schema)})\\.` : "";
  const name = `(?:${escapeRegex(quoteIdent(r.name, r.nameQuoted ?? false))}|${escapeRegex(r.name)})`;
  return new RegExp(
    `\\bCOMMENT\\s+ON\\s+${typeKw}\\s+${schema}${name}\\s*\\([^)]*\\)\\s+IS\\s+'(?:[^']|'')*'\\s*;`,
    "gi",
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the end position of a routine body in the source text.
 * Searches forward from the CREATE position for the body end ($$; or ';).
 */
function findRoutineBodyEnd(content: string, routine: ParsedRoutine): number {
  // Find the CREATE statement for this routine
  const schema = routine.schema
    ? `(?:${escapeRegex(quoteIdent(routine.schema, routine.schemaQuoted ?? false))}|${escapeRegex(routine.schema)})\\.`
    : "";
  const name = `(?:${escapeRegex(quoteIdent(routine.name, routine.nameQuoted ?? false))}|${escapeRegex(routine.name)})`;
  const createRe = new RegExp(
    `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:FUNCTION|PROCEDURE)\\s+${schema}${name}\\s*\\(`,
    "gi",
  );
  const createMatch = createRe.exec(content);
  if (!createMatch) return -1;

  // From the CREATE position, find the body end
  const rest = content.substring(createMatch.index);

  // Try dollar-quoted body: find AS $tag$...$tag$;
  const dollarRe = /\bAS\s+(\$[a-zA-Z_0-9]*\$)[\s\S]*?\1\s*;/i;
  const dollarMatch = rest.match(dollarRe);

  // Try single-quoted body: find AS [E]'...';
  const sqRe = /\bAS\s+(?:E)?'/i;
  const sqMatch = rest.match(sqRe);

  const dollarPos = dollarMatch?.index ?? Infinity;
  const sqPos = sqMatch?.index ?? Infinity;

  if (dollarMatch && dollarPos <= sqPos) {
    return createMatch.index + dollarMatch.index! + dollarMatch[0].length;
  }

  if (sqMatch && sqPos < dollarPos) {
    // Find end of single-quoted string
    let i = sqMatch.index! + sqMatch[0].length;
    while (i < rest.length) {
      if (rest[i] === "'" && rest[i + 1] === "'") { i += 2; continue; }
      if (rest[i] === "'") {
        // Find the semicolon after the closing quote
        const afterQuote = rest.substring(i + 1);
        const semi = afterQuote.match(/^\s*;/);
        return createMatch.index + i + 1 + (semi ? semi[0].length : 0);
      }
      i++;
    }
  }

  return -1;
}

/**
 * Apply comment fixes to a file. Returns the number of routines fixed.
 */
function applyCommentFixes(
  content: string,
  fixes: { routine: ParsedRoutine; catalogComment: string }[],
  formatOpts: FormatOptions,
): { content: string; count: number } {
  let result = content;
  let count = 0;

  for (const { routine, catalogComment } of fixes) {
    // Create a routine copy with the catalog comment for formatting
    const withComment: ParsedRoutine = { ...routine, comment: catalogComment };
    const commentSql = formatComment(withComment, formatOpts);
    if (!commentSql) continue;

    // Try to replace existing COMMENT ON
    const commentRe = buildCommentOnRegex(routine);
    if (commentRe.test(result)) {
      result = result.replace(commentRe, commentSql);
      count++;
      continue;
    }

    // No existing COMMENT ON — insert after routine body end
    const bodyEnd = findRoutineBodyEnd(result, routine);
    if (bodyEnd === -1) continue;

    // Insert COMMENT ON after the body end, with a blank line separator
    result = result.substring(0, bodyEnd) + "\n\n" + commentSql + result.substring(bodyEnd);
    count++;
  }

  return { content: result, count };
}

export async function diffCommand(config: PgdevConfig, fix?: FixFlags): Promise<void> {
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
  const parsedGroups = new Map<string, { routine: ParsedRoutine; file: string; display: string }[]>();
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
      group.push({ routine: r, file: relPath, display: dk });
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
  const needCreating: { display: string; file: string }[] = [];
  const needUpdating: { display: string; file: string; changes: string[] }[] = [];
  const needDropping: string[] = [];
  const matchedCatalogKeys = new Set<string>();

  // Collect fixable comment diffs grouped by absolute file path
  const commentFixes = new Map<string, { routine: ParsedRoutine; catalogComment: string }[]>();

  for (const [gk, parsedList] of parsedGroups) {
    const catList = catalogGroups.get(gk);
    if (!catList) {
      for (const p of parsedList) needCreating.push({ display: p.display, file: p.file });
      continue;
    }

    matchedCatalogKeys.add(gk);

    // Match each parsed routine to a catalog routine by param count
    const usedCat = new Set<number>();
    for (const p of parsedList) {
      const paramCount = p.routine.parameters.length;
      const catIdx = catList.findIndex((c, i) => !usedCat.has(i) && c.routine.parameters.length === paramCount);
      if (catIdx === -1) {
        needCreating.push({ display: p.display, file: p.file });
        continue;
      }
      usedCat.add(catIdx);
      const cat = catList[catIdx].routine;

      const changes: string[] = [];
      const diffOpts: DiffOptions = { ignoreBodyWhitespace: ignore_body_whitespace };
      if (routinesDiffer(p.routine, cat, diffOpts)) changes.push("definition");
      const hasCommentDiff = commentsDiffer(p.routine, cat);
      if (hasCommentDiff) changes.push("comment");
      if (grants && grantsDiffer(p.routine, cat)) changes.push("grants");

      if (changes.length > 0) {
        needUpdating.push({ display: p.display, file: p.file, changes });
      }

      // Collect comment fix if needed
      if (hasCommentDiff && fix?.comments && cat.comment != null) {
        const absFile = resolve(process.cwd(), p.file);
        let list = commentFixes.get(absFile);
        if (!list) { list = []; commentFixes.set(absFile, list); }
        list.push({ routine: p.routine, catalogComment: cat.comment });
      }
    }

    // Unmatched catalog routines in this group
    for (let i = 0; i < catList.length; i++) {
      if (!usedCat.has(i)) needDropping.push(catList[i].display);
    }
  }

  // Catalog routines with no parsed group at all
  for (const [gk, catList] of catalogGroups) {
    if (!matchedCatalogKeys.has(gk)) {
      for (const c of catList) needDropping.push(c.display);
    }
  }

  // Report
  const unchanged = totalParsed - needCreating.length - needUpdating.length;

  if (needCreating.length === 0 && needUpdating.length === 0 && needDropping.length === 0) {
    console.log(pc.green(`All ${totalParsed} routines match the database.`));
    if (fix?.comments) console.log(pc.dim("No comment differences to fix."));
    if (fix?.grants) console.log(pc.dim("No grant differences to fix."));
    if (fix?.definitions) console.log(pc.dim("No definition differences to fix."));
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
    for (const key of needDropping) {
      console.log(`  ${pc.red("-")} ${key}`);
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

  // Apply fixes
  if (fix?.comments && commentFixes.size > 0) {
    console.log();
    const formatOpts = configToFormatOptions(config.format);
    let totalFixed = 0;
    for (const [absFile, fixes] of commentFixes) {
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
      console.log(pc.green(`\nFixed ${totalFixed} comment${totalFixed > 1 ? "s" : ""}.`));
    }
  }

  if (fix?.definitions) {
    console.log(pc.yellow("\n--fix-definitions is not yet implemented."));
  }
  if (fix?.grants) {
    console.log(pc.yellow("\n--fix-grants is not yet implemented."));
  }
}
