export type ParameterDir = "in" | "out" | "inout" | "variadic";

export interface RoutineParameter {
  dir: ParameterDir | null;
  name: string | null;
  type: string;
}

export interface TableColumn {
  name: string;
  type: string;
}

export interface RoutineReturn {
  setof: boolean;
  type: string | null;
  table: TableColumn[] | null;
}

export interface ParsedRoutine {
  name: string;
  type: "function" | "procedure";
  schema: string | null;
  parameters: RoutineParameter[];
  returns: RoutineReturn | null;
  attributes: string[];
  body: string | null;
  comment: string | null;
}

/**
 * Strip comments from SQL content, preserving line structure.
 * Handles single-line (--) and nested block comments.
 */
function stripComments(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    // Dollar-quoted string — pass through without stripping comments
    if (sql[i] === "$") {
      const tagMatch = sql.substring(i).match(/^(\$[a-zA-Z_0-9]*\$)/);
      if (tagMatch) {
        const tag = tagMatch[1];
        result += tag;
        i += tag.length;
        const end = sql.indexOf(tag, i);
        if (end !== -1) {
          result += sql.substring(i, end + tag.length);
          i = end + tag.length;
        }
        continue;
      }
    }
    // Single-line comment
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    // Block comment (supports nesting)
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    result += sql[i];
    i++;
  }
  return result;
}

/**
 * Strip dollar-quoted string bodies from SQL, keeping only the
 * CREATE ... AS $tag$ portion (replacing the body with empty).
 * This prevents matching CREATE FUNCTION inside dynamic SQL strings.
 */
function stripDollarBodies(sql: string): string {
  const dollarQuoteRe = /(\$[a-zA-Z_0-9]*\$)([\s\S]*?)\1/g;
  return sql.replace(dollarQuoteRe, "$1$1");
}

/**
 * Extract the content between balanced parentheses starting at position `start`.
 * `start` must point to the opening `(`.
 */
function extractParenContent(sql: string, start: number): string {
  let depth = 1;
  let i = start + 1;
  while (i < sql.length && depth > 0) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") depth--;
    i++;
  }
  return sql.substring(start + 1, i - 1);
}

/**
 * Split a parameter list string by top-level commas (respecting nested parens).
 */
function splitParams(paramStr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of paramStr) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Multi-word PostgreSQL type patterns that could be confused with "name type".
 */
const MULTI_WORD_TYPE_RE =
  /^(?:character\s+varying|double\s+precision|bit\s+varying|timestamp\s+(?:with|without)\s+time\s+zone|time\s+(?:with|without)\s+time\s+zone)(?:\s*\([\d\s,]+\))?(?:\[\])*$/i;

const MODE_RE = /^(INOUT|IN|OUT|VARIADIC)\s+/i;

function parseOneParam(raw: string): RoutineParameter {
  let s = raw.trim();
  let dir: ParameterDir | null = null;
  const modeMatch = s.match(MODE_RE);
  if (modeMatch) {
    dir = modeMatch[1].toLowerCase() as ParameterDir;
    s = s.substring(modeMatch[0].length).trim();
  }
  s = s.replace(/\s+DEFAULT\s+.*/i, "").replace(/\s*=\s.*/, "").trim();

  if (!s) return { dir, name: null, type: "" };

  if (MULTI_WORD_TYPE_RE.test(s)) {
    return { dir, name: null, type: s };
  }

  const firstSpace = s.search(/\s/);
  if (firstSpace === -1) {
    return { dir, name: null, type: s };
  }

  return { dir, name: s.substring(0, firstSpace), type: s.substring(firstSpace + 1).trim() };
}

function parseParameters(paramStr: string): RoutineParameter[] {
  const trimmed = paramStr.trim();
  if (!trimmed) return [];
  return splitParams(trimmed).map(parseOneParam);
}

/**
 * Extract the routine body from the text following the parameter list.
 * Handles: dollar-quoted (AS $$...$$), single-quoted (AS '...'),
 * and SQL-standard atomic (BEGIN ATOMIC; ...; END;).
 */
function extractBody(sql: string, afterParams: number): string | null {
  const rest = sql.substring(afterParams);

  // 1. Dollar-quoted: AS $tag$...$tag$
  const dollarMatch = rest.match(/\bAS\s+(\$[a-zA-Z_0-9]*\$)([\s\S]*?)\1/i);
  if (dollarMatch) return dollarMatch[2];

  // 2. Single-quoted (with E prefix): AS [E]'...'
  const sqStart = rest.match(/\bAS\s+(E)?'/i);
  if (sqStart) {
    const offset = sqStart.index! + sqStart[0].length;
    let body = "";
    let i = offset;
    while (i < rest.length) {
      if (rest[i] === "'" && rest[i + 1] === "'") {
        body += "'";
        i += 2;
      } else if (rest[i] === "'") {
        break;
      } else {
        body += rest[i];
        i++;
      }
    }
    return body;
  }

  // 3. BEGIN ATOMIC; ...; END;
  const atomicMatch = rest.match(/\bBEGIN\s+ATOMIC\s*;([\s\S]*?)\bEND\s*;/i);
  if (atomicMatch) return atomicMatch[1];

  return null;
}

/**
 * Boundary keywords that terminate a RETURNS type clause.
 */
const RETURNS_BOUNDARY_RE =
  /\b(?:LANGUAGE|AS|BEGIN\s+ATOMIC|IMMUTABLE|STABLE|VOLATILE|SECURITY|PARALLEL|COST|ROWS|SET|STRICT|CALLED|EXTERNAL)\b/i;

/**
 * Parse a TABLE column definition: always "name type".
 */
function parseTableColumn(raw: string): TableColumn {
  const s = raw.trim();
  const firstSpace = s.search(/\s/);
  if (firstSpace === -1) return { name: s, type: "" };
  return { name: s.substring(0, firstSpace), type: s.substring(firstSpace + 1).trim() };
}

/**
 * Extract RETURNS clause from the text between closing paren and body.
 */
function extractReturns(cleaned: string, afterCloseParen: number): RoutineReturn | null {
  const rest = cleaned.substring(afterCloseParen);

  const returnsMatch = rest.match(/\bRETURNS\s+/i);
  if (!returnsMatch) return null;

  const afterReturns = returnsMatch.index! + returnsMatch[0].length;
  const tail = rest.substring(afterReturns);

  // RETURNS TABLE(...)
  const tableMatch = tail.match(/^TABLE\s*\(/i);
  if (tableMatch) {
    const parenStart = afterReturns + tableMatch[0].length - 1;
    const cols = extractParenContent(rest, parenStart);
    const table = splitParams(cols).map(parseTableColumn);
    return { setof: false, type: null, table };
  }

  // RETURNS SETOF type
  const setofMatch = tail.match(/^SETOF\s+/i);
  const typeStart = setofMatch ? tail.substring(setofMatch[0].length) : tail;

  // Find boundary where return type ends
  const boundaryMatch = typeStart.match(RETURNS_BOUNDARY_RE);
  const rawType = boundaryMatch
    ? typeStart.substring(0, boundaryMatch.index).trim()
    : typeStart.split(/[;\n]/)[0].trim();

  return { setof: !!setofMatch, type: rawType, table: null };
}

/**
 * Known attribute patterns, ordered longest-first to avoid partial matches.
 */
const ATTR_PATTERNS: RegExp[] = [
  /^RETURNS\s+NULL\s+ON\s+NULL\s+INPUT/i,
  /^CALLED\s+ON\s+NULL\s+INPUT/i,
  /^EXTERNAL\s+SECURITY\s+(?:INVOKER|DEFINER)/i,
  /^SECURITY\s+(?:INVOKER|DEFINER)/i,
  /^TRANSFORM\s+FOR\s+TYPE\s+\S+/i,
  /^NOT\s+LEAKPROOF/i,
  /^PARALLEL\s+(?:UNSAFE|RESTRICTED|SAFE)/i,
  /^SET\s+\S+\s+FROM\s+CURRENT/i,
  /^SET\s+\S+\s*(?:=|TO)\s*'[^']*'/i,
  /^SET\s+\S+\s*(?:=|TO)\s*\S+/i,
  /^LANGUAGE\s+\S+/i,
  /^SUPPORT\s+\S+/i,
  /^COST\s+\S+/i,
  /^ROWS\s+\S+/i,
  /^IMMUTABLE/i,
  /^STABLE/i,
  /^VOLATILE/i,
  /^LEAKPROOF/i,
  /^STRICT/i,
  /^WINDOW/i,
];

/**
 * Remove the RETURNS clause (return type, not RETURNS NULL ON NULL INPUT)
 * from the attribute zone text.
 */
function removeReturnsClause(zone: string): string {
  // Don't match RETURNS NULL ON NULL INPUT — that's an attribute
  const m = zone.match(/\bRETURNS\s+(?!NULL\s+ON\s+NULL\s+INPUT)/i);
  if (!m) return zone;

  const start = m.index!;
  const afterReturns = start + m[0].length;
  const tail = zone.substring(afterReturns);

  // RETURNS TABLE(...)
  const tableMatch = tail.match(/^TABLE\s*\(/i);
  if (tableMatch) {
    const parenIdx = afterReturns + tableMatch[0].length - 1;
    let depth = 1;
    let i = parenIdx + 1;
    while (i < zone.length && depth > 0) {
      if (zone[i] === "(") depth++;
      else if (zone[i] === ")") depth--;
      i++;
    }
    return zone.substring(0, start) + zone.substring(i);
  }

  // RETURNS [SETOF] type — type ends at next known keyword
  const setofMatch = tail.match(/^SETOF\s+/i);
  const typeOffset = afterReturns + (setofMatch ? setofMatch[0].length : 0);
  const typeText = zone.substring(typeOffset);
  const boundary = typeText.match(RETURNS_BOUNDARY_RE);
  const end = boundary ? typeOffset + boundary.index! : zone.length;
  return zone.substring(0, start) + zone.substring(end);
}

/**
 * Extract attribute clauses from the zone between closing paren and body.
 */
function extractAttributes(cleaned: string, closeParen: number): string[] {
  const rest = cleaned.substring(closeParen);

  // Find end of attribute zone: AS, BEGIN ATOMIC, or ;
  const endMatch = rest.match(/\bAS\s|BEGIN\s+ATOMIC/i);
  const endIdx = endMatch ? endMatch.index! : rest.indexOf(";");
  const zone = endIdx >= 0 ? rest.substring(0, endIdx) : rest;

  const withoutReturns = removeReturnsClause(zone);
  let s = withoutReturns.replace(/\s+/g, " ").trim();

  const attrs: string[] = [];
  while (s.length > 0) {
    let matched = false;
    for (const pattern of ATTR_PATTERNS) {
      const m = s.match(pattern);
      if (m) {
        attrs.push(m[0].replace(/\s+/g, " "));
        s = s.substring(m[0].length).trim();
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Skip unknown token
      const sp = s.indexOf(" ");
      s = sp === -1 ? "" : s.substring(sp + 1).trim();
    }
  }

  return attrs;
}

const CREATE_ROUTINE_RE =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\s+(?:([a-zA-Z_]\w*)\.)?([a-zA-Z_]\w*)\s*\(/gi;

/**
 * Match COMMENT ON FUNCTION/PROCEDURE [schema.]name(...) IS 'text';
 * Captures: type, schema (optional), name, param signature, comment string.
 */
const COMMENT_ON_RE =
  /\bCOMMENT\s+ON\s+(FUNCTION|PROCEDURE)\s+(?:([a-zA-Z_]\w*)\.)?([a-zA-Z_]\w*)\s*\(([^)]*)\)\s+IS\s+'((?:[^']|'')*)'\s*;/gi;

/**
 * Extract COMMENT ON statements and build a lookup map.
 * Key: "type:schema.name(normalized_param_types)" for matching to routines.
 */
function parseComments(commentStripped: string): Map<string, string> {
  const map = new Map<string, string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(COMMENT_ON_RE.source, COMMENT_ON_RE.flags);
  while ((m = re.exec(commentStripped)) !== null) {
    const type = m[1].toLowerCase();
    const schema = m[2] ?? "";
    const name = m[3];
    // COMMENT ON signatures may include param names (pg_dump style: "_id integer")
    // or just types ("integer"). Use parseOneParam to extract just the type.
    const params = m[4]
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => parseOneParam(p).type.toLowerCase())
      .join(",");
    const comment = m[5].replace(/''/g, "'");
    const key = `${type}:${schema}.${name}(${params})`;
    map.set(key, comment);
  }
  return map;
}

/**
 * Build a comment lookup key from a ParsedRoutine.
 */
function commentKey(r: { type: string; schema: string | null; name: string; parameters: RoutineParameter[] }): string {
  const params = r.parameters
    .map((p) => p.type.toLowerCase())
    .join(",");
  return `${r.type}:${r.schema ?? ""}.${r.name}(${params})`;
}

export function parseRoutines(content: string): ParsedRoutine[] {
  if (!content.trim()) return [];

  const commentStripped = stripComments(content);
  const cleaned = stripDollarBodies(commentStripped);
  const comments = parseComments(commentStripped);
  const routines: ParsedRoutine[] = [];

  let match: RegExpExecArray | null;
  while ((match = CREATE_ROUTINE_RE.exec(cleaned)) !== null) {
    const openParen = match.index + match[0].length - 1;
    const paramStr = extractParenContent(cleaned, openParen);
    const closeParen = openParen + paramStr.length + 2;
    const returns = extractReturns(cleaned, closeParen);
    const attributes = extractAttributes(cleaned, closeParen);
    // Extract body from comment-stripped (not dollar-stripped) text
    const body = extractBody(commentStripped, match.index);

    const routine: ParsedRoutine = {
      type: match[1].toLowerCase() as "function" | "procedure",
      schema: match[2] ?? null,
      name: match[3],
      parameters: parseParameters(paramStr),
      returns,
      attributes,
      body,
      comment: null,
    };

    const key = commentKey(routine);
    routine.comment = comments.get(key) ?? null;

    routines.push(routine);
  }

  return routines;
}
