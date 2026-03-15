import type { ParsedRoutine } from "./routine.ts";
import { quoteIdent } from "./routine.ts";
import { formatComment, formatGrants, qualifiedName, type FormatOptions } from "./formatter.ts";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a regex that matches an existing COMMENT ON for a routine. */
function buildCommentOnRegex(r: ParsedRoutine): RegExp {
  const typeKw = `(?:FUNCTION|PROCEDURE)`;
  const schema = r.schema ? `(?:${escapeRegex(quoteIdent(r.schema, r.schemaQuoted ?? false))}|${escapeRegex(r.schema)})\\.` : "";
  const name = `(?:${escapeRegex(quoteIdent(r.name, r.nameQuoted ?? false))}|${escapeRegex(r.name)})`;
  return new RegExp(
    `\\bCOMMENT\\s+ON\\s+${typeKw}\\s+${schema}${name}\\s*\\([^)]*(?:\\([^)]*\\)[^)]*)*\\)\\s+IS\\s+'(?:[^']|'')*'\\s*;`,
    "gi",
  );
}

/**
 * Find the end position of a routine body in the source text.
 * Searches forward from the CREATE position for the body end ($$; or ';).
 */
function findRoutineBodyEnd(content: string, routine: ParsedRoutine): number {
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
    let i = sqMatch.index! + sqMatch[0].length;
    while (i < rest.length) {
      if (rest[i] === "'" && rest[i + 1] === "'") { i += 2; continue; }
      if (rest[i] === "'") {
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
export function applyCommentFixes(
  content: string,
  fixes: { routine: ParsedRoutine; catalogComment: string }[],
  formatOpts: FormatOptions,
): { content: string; count: number } {
  let result = content;
  let count = 0;

  for (const { routine, catalogComment } of fixes) {
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

    result = result.substring(0, bodyEnd) + "\n\n" + commentSql + result.substring(bodyEnd);
    count++;
  }

  return { content: result, count };
}

/**
 * Remove COMMENT ON statements for routines that have no comment in the database.
 */
export function removeComments(
  content: string,
  routines: ParsedRoutine[],
): { content: string; count: number } {
  let result = content;
  let count = 0;

  for (const routine of routines) {
    const commentRe = buildCommentOnRegex(routine);
    const before = result;
    // Remove the COMMENT ON statement and any surrounding blank lines
    result = result.replace(commentRe, "");
    // Clean up extra blank lines left behind
    result = result.replace(/\n{3,}/g, "\n\n");
    if (result !== before) count++;
  }

  return { content: result, count };
}

/**
 * Build a regex that matches a routine's dollar-quoted body (AS $tag$...$tag$;).
 */
function buildBodyRegex(r: ParsedRoutine): RegExp {
  const schema = r.schema
    ? `(?:${escapeRegex(quoteIdent(r.schema, r.schemaQuoted ?? false))}|${escapeRegex(r.schema)})\\.`
    : "";
  const name = `(?:${escapeRegex(quoteIdent(r.name, r.nameQuoted ?? false))}|${escapeRegex(r.name)})`;
  // Match CREATE ... name( ... AS $tag$ ... $tag$;
  return new RegExp(
    `(\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:FUNCTION|PROCEDURE)\\s+${schema}${name}\\s*\\([\\s\\S]*?\\bAS\\s+)(\\$[a-zA-Z_0-9]*\\$)([\\s\\S]*?)\\2(\\s*;)`,
    "gi",
  );
}

/**
 * Apply body fixes to a file. Replaces the body content between dollar-quote tags.
 */
export function applyBodyFixes(
  content: string,
  fixes: { routine: ParsedRoutine; catalogBody: string }[],
): { content: string; count: number } {
  let result = content;
  let count = 0;

  for (const { routine, catalogBody } of fixes) {
    const bodyRe = buildBodyRegex(routine);
    const before = result;
    result = result.replace(bodyRe, (_match, prefix, openTag, _oldBody, suffix) => {
      return `${prefix}${openTag}${catalogBody}${openTag}${suffix}`;
    });
    if (result !== before) count++;
  }

  return { content: result, count };
}

/**
 * Build a regex that matches GRANT/REVOKE statements for a routine.
 */
function buildGrantRevokeRegex(r: ParsedRoutine): RegExp {
  const schema = r.schema
    ? `(?:${escapeRegex(quoteIdent(r.schema, r.schemaQuoted ?? false))}|${escapeRegex(r.schema)})\\.`
    : "";
  const name = `(?:${escapeRegex(quoteIdent(r.name, r.nameQuoted ?? false))}|${escapeRegex(r.name)})`;
  return new RegExp(
    `\\b(?:GRANT|REVOKE)\\s+(?:EXECUTE|ALL(?:\\s+PRIVILEGES)?)\\s+ON\\s+(?:FUNCTION|PROCEDURE)\\s+${schema}${name}\\s*\\([^)]*\\)\\s+(?:TO|FROM)\\s+[^;]+;[ \\t]*\\n?`,
    "gi",
  );
}

/**
 * Apply grant fixes to a file. Replaces all GRANT/REVOKE statements for each routine.
 */
export function applyGrantFixes(
  content: string,
  fixes: { routine: ParsedRoutine; catalogGrants: ParsedRoutine["grants"] }[],
  formatOpts: FormatOptions,
): { content: string; count: number } {
  let result = content;
  let count = 0;

  for (const { routine, catalogGrants } of fixes) {
    // Remove existing GRANT/REVOKE statements
    const grantRe = buildGrantRevokeRegex(routine);
    const stripped = result.replace(grantRe, "");

    // Format new grants
    const withGrants: ParsedRoutine = { ...routine, grants: catalogGrants };
    const grantLines = formatGrants(withGrants, formatOpts);

    if (grantLines.length === 0 && stripped === result) continue; // no change

    if (grantLines.length > 0) {
      // Insert after routine body end (or after COMMENT ON if present)
      const commentRe = buildCommentOnRegex(routine);
      const commentMatch = commentRe.exec(stripped);
      const bodyEnd = findRoutineBodyEnd(stripped, routine);

      let insertPos: number;
      if (commentMatch) {
        insertPos = commentMatch.index + commentMatch[0].length;
      } else if (bodyEnd !== -1) {
        insertPos = bodyEnd;
      } else {
        continue; // can't find where to insert
      }

      result = stripped.substring(0, insertPos) + "\n\n" + grantLines.join("\n") + stripped.substring(insertPos);
    } else {
      result = stripped;
    }
    count++;
  }

  return { content: result, count };
}
