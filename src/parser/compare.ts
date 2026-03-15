import type { ParsedRoutine, RoutineGrant } from "./routine.ts";
import type { CatalogRoutine } from "./catalog.ts";
import { bodyHash } from "./catalog.ts";

/**
 * Map of common PostgreSQL type aliases to their canonical names
 * (as returned by format_type()).
 */
const TYPE_ALIASES: Record<string, string> = {
  int: "integer",
  int4: "integer",
  int2: "smallint",
  int8: "bigint",
  float4: "real",
  float8: "double precision",
  bool: "boolean",
  varchar: "character varying",
  char: "character",
  timestamp: "timestamp without time zone",
  timestamptz: "timestamp with time zone",
  time: "time without time zone",
  timetz: "time with time zone",
  serial: "integer",
  serial4: "integer",
  bigserial: "bigint",
  serial8: "bigint",
  smallserial: "smallint",
  serial2: "smallint",
};

/** Normalize a SQL type to its canonical form (as returned by format_type). */
export function normalizeType(type: string): string {
  const lower = type.toLowerCase().trim();

  // Handle array suffix: normalize base type, preserve []
  if (lower.endsWith("[]")) {
    const base = lower.slice(0, -2);
    return normalizeType(base) + "[]";
  }

  // Handle types with modifiers: char(1), varchar(255), numeric(10,2), etc.
  const modMatch = lower.match(/^(\w+)\((.+)\)$/);
  if (modMatch) {
    const baseName = modMatch[1];
    const modifier = modMatch[2];
    const canonicalBase = TYPE_ALIASES[baseName] ?? baseName;

    // char(1) / character(1) → character (1 is the default length)
    if ((canonicalBase === "character") && modifier.trim() === "1") {
      return "character";
    }

    return `${canonicalBase}(${modifier})`;
  }

  return TYPE_ALIASES[lower] ?? lower;
}

/**
 * PostgreSQL default values for routine attributes when not explicitly specified.
 */
const PG_DEFAULTS = {
  language: "sql",
  volatility: "volatile" as const,
  strict: false,
  securityDefiner: false,
  parallel: "unsafe" as const,
  leakproof: false,
  cost: 100,
  rowsSetof: 1000,
  rowsScalar: 0,
};

export interface ExpectedAttributes {
  language: string;
  volatility: "immutable" | "stable" | "volatile";
  strict: boolean;
  securityDefiner: boolean;
  parallel: "safe" | "restricted" | "unsafe";
  leakproof: boolean;
  cost: number;
  rows: number;
  config: string[];
}

/**
 * Convert ParsedRoutine.attributes to expected catalog field values,
 * applying PostgreSQL defaults for any attribute not explicitly specified.
 */
export function attributesToCatalog(parsed: ParsedRoutine): ExpectedAttributes {
  const attrs = parsed.attributes;

  // Language
  const langAttr = attrs.find((a) => /^LANGUAGE\s/i.test(a));
  const language = langAttr ? langAttr.split(/\s+/)[1].toLowerCase() : PG_DEFAULTS.language;

  // Volatility
  let volatility: ExpectedAttributes["volatility"] = PG_DEFAULTS.volatility;
  if (attrs.some((a) => /^IMMUTABLE$/i.test(a))) volatility = "immutable";
  else if (attrs.some((a) => /^STABLE$/i.test(a))) volatility = "stable";
  else if (attrs.some((a) => /^VOLATILE$/i.test(a))) volatility = "volatile";

  // Strict
  let strict = PG_DEFAULTS.strict;
  if (attrs.some((a) => /^STRICT$/i.test(a) || /^RETURNS\s+NULL\s+ON\s+NULL\s+INPUT$/i.test(a)))
    strict = true;
  else if (attrs.some((a) => /^CALLED\s+ON\s+NULL\s+INPUT$/i.test(a))) strict = false;

  // Security definer
  let securityDefiner = PG_DEFAULTS.securityDefiner;
  if (attrs.some((a) => /^(EXTERNAL\s+)?SECURITY\s+DEFINER$/i.test(a))) securityDefiner = true;
  else if (attrs.some((a) => /^(EXTERNAL\s+)?SECURITY\s+INVOKER$/i.test(a)))
    securityDefiner = false;

  // Parallel
  let parallel: ExpectedAttributes["parallel"] = PG_DEFAULTS.parallel;
  if (attrs.some((a) => /^PARALLEL\s+SAFE$/i.test(a))) parallel = "safe";
  else if (attrs.some((a) => /^PARALLEL\s+RESTRICTED$/i.test(a))) parallel = "restricted";
  else if (attrs.some((a) => /^PARALLEL\s+UNSAFE$/i.test(a))) parallel = "unsafe";

  // Leakproof
  let leakproof = PG_DEFAULTS.leakproof;
  if (attrs.some((a) => /^LEAKPROOF$/i.test(a))) leakproof = true;
  else if (attrs.some((a) => /^NOT\s+LEAKPROOF$/i.test(a))) leakproof = false;

  // Cost
  const costAttr = attrs.find((a) => /^COST\s/i.test(a));
  const cost = costAttr ? Number(costAttr.split(/\s+/)[1]) : PG_DEFAULTS.cost;

  // Rows — default depends on whether function returns SETOF (RETURNS TABLE is also setof)
  const isSetof = (parsed.returns?.setof ?? false) || parsed.returns?.table != null;
  const rowsAttr = attrs.find((a) => /^ROWS\s/i.test(a));
  const rows = rowsAttr
    ? Number(rowsAttr.split(/\s+/)[1])
    : isSetof
      ? PG_DEFAULTS.rowsSetof
      : PG_DEFAULTS.rowsScalar;

  // Config (SET variable = value)
  const config = attrs
    .filter((a) => /^SET\s/i.test(a))
    .map((a) => {
      // PG stores as "var=val" in proconfig; parser has "SET var = val" or "SET var TO val"
      // PG also strips surrounding single quotes from values
      const m = a.match(/^SET\s+(\S+)\s*(?:=|TO)\s*(.+)$/i);
      if (!m) return a;
      // Strip surrounding single quotes from each comma-separated value
      // PG stores proconfig as "var=val1, val2" without quotes
      const val = m[2].replace(/'([^']*)'/g, "$1");
      return `${m[1]}=${val}`;
    });

  return { language, volatility, strict, securityDefiner, parallel, leakproof, cost, rows, config };
}

/**
 * Compare a parsed routine (from SQL file) with a catalog routine (from pg_catalog).
 * Returns true if they differ and the database needs updating.
 */
export interface DiffOptions {
  ignoreBodyWhitespace?: boolean;
}

export function routinesDiffer(parsed: ParsedRoutine, catalog: CatalogRoutine, options?: DiffOptions): boolean {
  // Type
  if (parsed.type !== catalog.type) return true;

  // Parameters — compare count, names, and types (skip dir, catalog doesn't track it)
  if (parsed.parameters.length !== catalog.parameters.length) return true;
  for (let i = 0; i < parsed.parameters.length; i++) {
    if (parsed.parameters[i].name !== catalog.parameters[i].name) return true;
    if (normalizeType(parsed.parameters[i].type) !== normalizeType(catalog.parameters[i].type))
      return true;
  }

  // Returns
  if (returnsDiffer(parsed, catalog)) return true;

  // Body
  if (bodyDiffers(parsed.body, catalog.body, options?.ignoreBodyWhitespace)) return true;

  // Attributes
  if (attributesDiffer(parsed, catalog)) return true;

  return false;
}

/**
 * Compare comments between a parsed routine (from SQL file) and a catalog routine (from pg_catalog).
 * Returns true if the comments differ. Separate from routinesDiffer because comment
 * changes don't require re-creating the routine — they use COMMENT ON.
 */
export function commentsDiffer(parsed: ParsedRoutine, catalog: CatalogRoutine): boolean {
  const pc = parsed.comment ?? null;
  const cc = catalog.comment ?? null;
  return pc !== cc;
}

/**
 * Convert parsed GRANT/REVOKE statements into a set of PostgreSQL ACL entries.
 * pg_dump always outputs REVOKE ALL first, then explicit GRANTs, producing
 * a deterministic final state. We replay the statements in order.
 *
 * ACL entry format: "grantee=privs/grantor" where:
 *   - X = EXECUTE
 *   - empty grantee = PUBLIC
 *   - * suffix = WITH GRANT OPTION
 */
export function grantsToAcl(grants: RoutineGrant[], owner: string): string[] {
  // Track who has EXECUTE. Start empty (pg_dump always begins with REVOKE ALL)
  const acl = new Map<string, boolean>();

  for (const g of grants) {
    const grantee = g.grantee.toUpperCase() === "PUBLIC" ? "" : g.grantee;
    if (g.isGrant) {
      acl.set(grantee, true);
    } else {
      // REVOKE
      if (g.grantee.toUpperCase() === "PUBLIC" && g.privilege === "ALL") {
        // REVOKE ALL FROM PUBLIC — clear PUBLIC
        acl.delete("");
      } else {
        acl.delete(grantee);
      }
    }
  }

  return [...acl.keys()]
    .sort()
    .map((grantee) => `${grantee}=X/${owner}`);
}

/**
 * Compare grants/ACLs between a parsed routine and a catalog routine.
 * Returns true if they differ. Separate from routinesDiffer because
 * grant changes use GRANT/REVOKE statements (no routine re-creation needed).
 */
export function grantsDiffer(parsed: ParsedRoutine, catalog: CatalogRoutine): boolean {
  // If no grants parsed and catalog has null ACL, they match (default permissions)
  if (parsed.grants.length === 0 && catalog.acl == null) return false;

  // If parsed has no grants but catalog has explicit ACL (or vice versa)
  if (parsed.grants.length === 0 && catalog.acl != null) return true;
  if (parsed.grants.length > 0 && catalog.acl == null) return true;

  // Extract owner from catalog ACL (format: "grantee=privs/grantor")
  const ownerMatch = catalog.acl![0]?.match(/\/(\w+)$/);
  const owner = ownerMatch ? ownerMatch[1] : "";

  // Filter out owner's self-grant from catalog ACL — the owner always retains
  // EXECUTE and pg_dump includes an explicit "GRANT ... TO owner" line, but
  // user-written SQL typically omits it. Compare only non-owner entries.
  const ownerEntry = `${owner}=X/${owner}`;
  const actual = [...(catalog.acl ?? [])]
    .filter((a) => a !== ownerEntry)
    .sort();

  const expected = grantsToAcl(parsed.grants, owner);

  if (expected.length !== actual.length) return true;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) return true;
  }
  return false;
}

/**
 * Compare two ParsedRoutine objects (e.g. file vs pg_dump output).
 * Returns true if they differ functionally (ignoring formatting).
 */
export function parsedRoutinesDiffer(a: ParsedRoutine, b: ParsedRoutine, options?: DiffOptions): boolean {
  if (a.type !== b.type) return true;

  // Parameters
  if (a.parameters.length !== b.parameters.length) return true;
  for (let i = 0; i < a.parameters.length; i++) {
    if ((a.parameters[i].name ?? null) !== (b.parameters[i].name ?? null)) return true;
    if (normalizeType(a.parameters[i].type) !== normalizeType(b.parameters[i].type)) return true;
  }

  // Returns
  if (parsedReturnsDiffer(a.returns, b.returns)) return true;

  // Body
  if (bodyDiffers(a.body, b.body, options?.ignoreBodyWhitespace)) return true;

  // Attributes — normalize both to catalog form and compare
  const attrsA = attributesToCatalog(a);
  const attrsB = attributesToCatalog(b);
  if (attrsA.language !== attrsB.language) return true;
  if (attrsA.volatility !== attrsB.volatility) return true;
  if (attrsA.strict !== attrsB.strict) return true;
  if (attrsA.securityDefiner !== attrsB.securityDefiner) return true;
  if (attrsA.parallel !== attrsB.parallel) return true;
  if (attrsA.leakproof !== attrsB.leakproof) return true;
  if (attrsA.cost !== attrsB.cost) return true;
  if (attrsA.rows !== attrsB.rows) return true;
  if (attrsA.config.length !== attrsB.config.length) return true;
  for (let i = 0; i < attrsA.config.length; i++) {
    if (attrsA.config[i] !== attrsB.config[i]) return true;
  }

  // Comment
  if ((a.comment ?? null) !== (b.comment ?? null)) return true;

  // Grants
  if (a.grants.length !== b.grants.length) return true;
  for (let i = 0; i < a.grants.length; i++) {
    if (a.grants[i].privilege !== b.grants[i].privilege) return true;
    if (a.grants[i].grantee !== b.grants[i].grantee) return true;
    if (a.grants[i].isGrant !== b.grants[i].isGrant) return true;
  }

  return false;
}

function parsedReturnsDiffer(a: ParsedRoutine["returns"], b: ParsedRoutine["returns"]): boolean {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;

  if (a.setof !== b.setof) return true;
  if (normalizeType(a.type ?? "") !== normalizeType(b.type ?? "")) return true;

  // TABLE columns
  if ((a.table == null) !== (b.table == null)) return true;
  if (a.table && b.table) {
    if (a.table.length !== b.table.length) return true;
    for (let i = 0; i < a.table.length; i++) {
      if (a.table[i].name !== b.table[i].name) return true;
      if (normalizeType(a.table[i].type) !== normalizeType(b.table[i].type)) return true;
    }
  }

  return false;
}

function returnsDiffer(parsed: ParsedRoutine, catalog: CatalogRoutine): boolean {
  const pr = parsed.returns;
  const cr = catalog.returns;

  // Both null (procedures)
  if (pr == null && cr == null) return false;
  // One null, other not
  if (pr == null || cr == null) return true;

  // RETURNS TABLE — parser has table array, catalog has {setof: true, type: "record"}
  // Column-level changes are not detectable via the current catalog query
  if (pr.table != null) {
    return !(cr.setof === true && cr.type === "record");
  }

  // Scalar / SETOF type
  if (pr.setof !== cr.setof) return true;
  if (normalizeType(pr.type ?? "") !== normalizeType(cr.type ?? "")) return true;

  return false;
}

function bodyDiffers(parsedBody: string | null, catalogBody: string | null, ignoreWhitespace = false): boolean {
  if (parsedBody == null && catalogBody == null) return false;
  if (parsedBody == null || catalogBody == null) return true;
  return bodyHash(parsedBody, ignoreWhitespace) !== bodyHash(catalogBody, ignoreWhitespace);
}

function attributesDiffer(parsed: ParsedRoutine, catalog: CatalogRoutine): boolean {
  const expected = attributesToCatalog(parsed);

  if (catalog.language !== expected.language) return true;
  if (catalog.volatility !== expected.volatility) return true;
  if (catalog.strict !== expected.strict) return true;
  if (catalog.securityDefiner !== expected.securityDefiner) return true;
  if (catalog.parallel !== expected.parallel) return true;
  if (catalog.leakproof !== expected.leakproof) return true;
  if (catalog.cost !== expected.cost) return true;
  if (catalog.rows !== expected.rows) return true;

  // Config array comparison
  if (catalog.config.length !== expected.config.length) return true;
  for (let i = 0; i < catalog.config.length; i++) {
    if (catalog.config[i] !== expected.config[i]) return true;
  }

  return false;
}
