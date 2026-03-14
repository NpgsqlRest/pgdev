import type { ParsedRoutine } from "./routine.ts";
import { quoteIdent } from "./routine.ts";
import type { FormatConfig } from "../config.ts";

export interface FormatOptions {
  /** Lowercase SQL keywords (default: true) */
  lowercase: boolean;
  /** Parameter layout: "inline" or "multiline" (default: "multiline") */
  paramStyle: "inline" | "multiline";
  /** Indentation string (default: "    ") */
  indent: string;
  /** Simplify default expressions like (NULL::text = NULL::text) → null (default: true) */
  simplifyDefaults: boolean;
  /** Omit IN direction since it's the default (default: true) */
  omitDefaultDirection: boolean;
  /** Attribute placement: "inline" or "multiline" (default: "multiline") */
  attributeStyle: "inline" | "multiline";
  /** Remove pg_dump header/footer comments (default: true) */
  stripDumpComments: boolean;
  /** Comment signature: "types_only" or "full" (default: "types_only") */
  commentSignatureStyle: "types_only" | "full";
  /** Add DROP FUNCTION/PROCEDURE IF EXISTS before CREATE (default: true) */
  dropBeforeCreate: boolean;
  /** Use CREATE OR REPLACE instead of CREATE (default: false) */
  createOrReplace: boolean;
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  lowercase: true,
  paramStyle: "multiline",
  indent: "    ",
  simplifyDefaults: true,
  omitDefaultDirection: true,
  attributeStyle: "multiline",
  stripDumpComments: true,
  commentSignatureStyle: "types_only",
  dropBeforeCreate: true,
  createOrReplace: false,
};

/**
 * Simplify a pg_dump default expression to a more human-readable form.
 * - (NULL::type = NULL::type) → null
 * - NULL::type → null
 * - 'value'::type → 'value'
 * - (value)::type → value (for simple parenthesized expressions)
 */
function simplifyDefault(expr: string): string {
  // (NULL::type = NULL::type) → null
  if (/^\(NULL::\w+\s*=\s*NULL::\w+\)$/i.test(expr)) return "null";

  // NULL::type → null
  if (/^NULL::\w+$/i.test(expr)) return "null";

  // 'value'::type → 'value'  (but keep the value itself)
  const quotedCast = expr.match(/^'([^']*)'(?:::\w+(?:\[\])?)$/);
  if (quotedCast) return `'${quotedCast[1]}'`;

  // (value)::type for simple numeric/literal → value
  const parenCast = expr.match(/^\(([^)]+)\)(?:::\w+(?:\[\])?)$/);
  if (parenCast) {
    const inner = parenCast[1].trim();
    // Only simplify if inner is a simple literal (number, string, null)
    if (/^[\d.]+$/.test(inner) || /^'[^']*'$/.test(inner) || /^null$/i.test(inner)) {
      return inner.toLowerCase() === "null" ? "null" : inner;
    }
  }

  return expr;
}

function kw(word: string, lowercase: boolean): string {
  return lowercase ? word.toLowerCase() : word.toUpperCase();
}

/** Build schema-qualified name, quoting identifiers that were quoted in the source. */
export function qualifiedName(r: ParsedRoutine): string {
  const name = quoteIdent(r.name, r.nameQuoted ?? false);
  if (r.schema) {
    const schema = quoteIdent(r.schema, r.schemaQuoted ?? false);
    return `${schema}.${name}`;
  }
  return name;
}

/** Format the CREATE FUNCTION/PROCEDURE header with parameters. */
function formatHeader(r: ParsedRoutine, opts: FormatOptions): string {
  const orReplace = opts.createOrReplace ? ` ${kw("OR REPLACE", opts.lowercase)}` : "";
  const createKw = r.type === "function"
    ? `${kw("CREATE", opts.lowercase)}${orReplace} ${kw("FUNCTION", opts.lowercase)}`
    : `${kw("CREATE", opts.lowercase)}${orReplace} ${kw("PROCEDURE", opts.lowercase)}`;

  const qualName = qualifiedName(r);

  // Format parameters
  const params = r.parameters.map((p) => {
    const parts: string[] = [];

    // Direction
    if (p.dir && !(opts.omitDefaultDirection && p.dir === "in")) {
      parts.push(kw(p.dir, opts.lowercase));
    }

    // Name
    if (p.name) parts.push(p.name);

    // Type
    parts.push(opts.lowercase ? p.type.toLowerCase() : p.type);

    // Default
    if (p.default != null) {
      const def = opts.simplifyDefaults ? simplifyDefault(p.default) : p.default;
      parts.push(`= ${def}`);
    }

    return parts.join(" ");
  });

  if (params.length === 0) {
    return `${createKw} ${qualName}()`;
  }

  if (opts.paramStyle === "inline") {
    return `${createKw} ${qualName}(${params.join(", ")})`;
  }

  // Multiline
  const paramLines = params.map((p, i) => {
    const comma = i < params.length - 1 ? "," : "";
    return `${opts.indent}${p}${comma}`;
  });
  return `${createKw} ${qualName}(\n${paramLines.join("\n")}\n)`;
}

/** Format the RETURNS clause. */
function formatReturns(r: ParsedRoutine, opts: FormatOptions): string | null {
  if (!r.returns) return null;

  if (r.returns.table) {
    const cols = r.returns.table.map((c) => {
      const type = opts.lowercase ? c.type.toLowerCase() : c.type;
      return `${opts.indent}${c.name} ${type}`;
    });
    return `${kw("RETURNS", opts.lowercase)} ${kw("TABLE", opts.lowercase)}(\n${cols.join(",\n")}\n)`;
  }

  const parts: string[] = [kw("RETURNS", opts.lowercase)];
  if (r.returns.setof) parts.push(kw("SETOF", opts.lowercase));
  if (r.returns.type) {
    parts.push(opts.lowercase ? r.returns.type.toLowerCase() : r.returns.type.toUpperCase());
  }
  return parts.join(" ");
}

/**
 * Known attribute prefixes for grouping.
 */
function formatAttribute(attr: string, lowercase: boolean): string {
  return lowercase ? attr.toLowerCase() : attr.toUpperCase();
}

/** Format attributes (LANGUAGE, SECURITY DEFINER, IMMUTABLE, etc.). */
function formatAttributes(r: ParsedRoutine, opts: FormatOptions): string[] {
  // Reorder: non-LANGUAGE attributes first, then LANGUAGE
  const langAttr = r.attributes.find((a) => /^LANGUAGE\s/i.test(a));
  const others = r.attributes.filter((a) => !/^LANGUAGE\s/i.test(a));

  const ordered = [...others];
  if (langAttr) ordered.push(langAttr);

  return ordered.map((a) => formatAttribute(a, opts.lowercase));
}

/** Format the body with dollar quoting. */
function formatBody(r: ParsedRoutine, opts: FormatOptions): string | null {
  if (r.body == null) return null;
  return `${kw("AS", opts.lowercase)}\n$$${r.body}$$`;
}

/** Format COMMENT ON statement. */
export function formatComment(r: ParsedRoutine, opts: FormatOptions): string | null {
  if (r.comment == null) return null;

  const typeKw = r.type === "function"
    ? kw("FUNCTION", opts.lowercase)
    : kw("PROCEDURE", opts.lowercase);
  const qualName = qualifiedName(r);

  let sig: string;
  if (opts.commentSignatureStyle === "types_only") {
    sig = r.parameters
      .map((p) => opts.lowercase ? p.type.toLowerCase() : p.type)
      .join(", ");
  } else {
    sig = r.parameters
      .map((p) => {
        const parts: string[] = [];
        if (p.dir && !(opts.omitDefaultDirection && p.dir === "in")) {
          parts.push(kw(p.dir, opts.lowercase));
        }
        if (p.name) parts.push(p.name);
        parts.push(opts.lowercase ? p.type.toLowerCase() : p.type);
        return parts.join(" ");
      })
      .join(", ");
  }

  // Escape single quotes in comment text
  const escaped = r.comment.replace(/'/g, "''");
  return `${kw("COMMENT ON", opts.lowercase)} ${typeKw} ${qualName}(${sig}) ${kw("IS", opts.lowercase)} '${escaped}';`;
}

/** Format GRANT/REVOKE statements. */
export function formatGrants(r: ParsedRoutine, opts: FormatOptions): string[] {
  if (r.grants.length === 0) return [];

  const typeKw = r.type === "function"
    ? kw("FUNCTION", opts.lowercase)
    : kw("PROCEDURE", opts.lowercase);
  const qualName = qualifiedName(r);
  const sig = r.parameters
    .map((p) => opts.lowercase ? p.type.toLowerCase() : p.type)
    .join(", ");

  return r.grants.map((g) => {
    const action = g.isGrant ? kw("GRANT", opts.lowercase) : kw("REVOKE", opts.lowercase);
    const priv = kw(g.privilege, opts.lowercase);
    const preposition = g.isGrant
      ? kw("TO", opts.lowercase)
      : kw("FROM", opts.lowercase);
    const onKw = kw("ON", opts.lowercase);
    return `${action} ${priv} ${onKw} ${typeKw} ${qualName}(${sig}) ${preposition} ${g.grantee};`;
  });
}

/** Format a single parsed routine to SQL text. */
export function formatRoutine(r: ParsedRoutine, options?: Partial<FormatOptions>): string {
  const opts: FormatOptions = { ...DEFAULT_FORMAT_OPTIONS, ...options };
  const parts: string[] = [];

  // DROP IF EXISTS before CREATE
  if (opts.dropBeforeCreate) {
    const typeKw = r.type === "function"
      ? kw("FUNCTION", opts.lowercase)
      : kw("PROCEDURE", opts.lowercase);
    const qualName = qualifiedName(r);
    const sig = r.parameters
      .map((p) => opts.lowercase ? p.type.toLowerCase() : p.type.toUpperCase())
      .join(", ");
    parts.push(`${kw("DROP", opts.lowercase)} ${typeKw} ${kw("IF EXISTS", opts.lowercase)} ${qualName}(${sig});`);
    parts.push("");
  }

  // Header (CREATE + params)
  parts.push(formatHeader(r, opts));

  // Returns
  const returns = formatReturns(r, opts);

  // Attributes
  const attrs = formatAttributes(r, opts);

  // Build the section between ) and AS
  const midParts: string[] = [];
  if (returns) midParts.push(returns);
  midParts.push(...attrs);

  if (opts.attributeStyle === "multiline") {
    // Each on its own line
    for (const part of midParts) {
      parts.push(part);
    }
  } else {
    // All inline after the header
    if (midParts.length > 0) {
      parts[parts.length - 1] += " " + midParts.join(" ");
    }
  }

  // Body
  const body = formatBody(r, opts);
  if (body) {
    parts.push(body + ";");
  }

  let result = parts.join("\n");

  // Comment
  const comment = formatComment(r, opts);
  if (comment) {
    result += "\n\n" + comment;
  }

  // Grants
  const grants = formatGrants(r, opts);
  if (grants.length > 0) {
    result += "\n\n" + grants.join("\n");
  }

  return result + "\n";
}

/** Format multiple parsed routines into a single SQL file. */
export function formatRoutines(routines: ParsedRoutine[], options?: Partial<FormatOptions>): string {
  if (routines.length === 0) return "";
  return routines.map((r) => formatRoutine(r, options)).join("\n");
}

/** Default prefixes to skip when grouping routines by name segment. */
export const DEFAULT_SKIP_PREFIXES: string[] = [
  // CRUD / query
  "get", "select", "read", "fetch", "find", "list", "load", "search", "lookup", "all",
  // write
  "set", "update", "put", "upsert", "insert", "add", "create", "save", "store", "write",
  // delete
  "delete", "remove", "drop", "clear", "purge",
  // boolean
  "is", "has", "can", "check", "validate", "verify",
  // math
  "count", "sum", "compute", "calculate",
  // action
  "run", "execute", "do", "process", "handle", "call", "invoke", "trigger", "perform",
  "send", "notify", "emit", "sync", "refresh", "reset", "init", "setup",
  "parse", "format", "convert", "transform", "generate", "build", "make",
  "ensure", "try",
];

/**
 * Extract a directory group name from a routine's snake_case name.
 * Returns empty string if grouping doesn't apply (segment=0 or name too short).
 */
export function getGroupDir(name: string, segment: number, skipPrefixes: Set<string>): string {
  if (segment <= 0) return "";
  const parts = name.split("_");
  let idx = segment - 1; // convert to 0-based
  if (idx >= parts.length) return "";
  if (skipPrefixes.size > 0) {
    while (idx < parts.length - 1 && skipPrefixes.has(parts[idx])) {
      idx++;
    }
  }
  return parts[idx];
}

/** A routine is "public" if its comment contains HTTP at start or at start of a new line. */
export function isApiRoutine(routines: ParsedRoutine[]): boolean {
  return routines.some((r) => r.comment != null && /(?:^|\n)HTTP\b/.test(r.comment));
}

/** Convert snake_case FormatConfig from pgdev.toml to camelCase FormatOptions. */
export function configToFormatOptions(config: FormatConfig): FormatOptions {
  return {
    lowercase: config.lowercase,
    paramStyle: config.param_style,
    indent: config.indent,
    simplifyDefaults: config.simplify_defaults,
    omitDefaultDirection: config.omit_default_direction,
    attributeStyle: config.attribute_style,
    stripDumpComments: config.strip_dump_comments,
    commentSignatureStyle: config.comment_signature_style,
    dropBeforeCreate: config.drop_before_create,
    createOrReplace: config.create_or_replace,
  };
}
