import type { ParsedRoutine } from "./routine.ts";
import type { CatalogRoutine } from "./catalog.ts";
import { bodyHash } from "./catalog.ts";

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

  // Rows — default depends on whether function returns SETOF
  const isSetof = parsed.returns?.setof ?? false;
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
      const val = m[2].replace(/^'(.*)'$/, "$1");
      return `${m[1]}=${val}`;
    });

  return { language, volatility, strict, securityDefiner, parallel, leakproof, cost, rows, config };
}

/**
 * Compare a parsed routine (from SQL file) with a catalog routine (from pg_catalog).
 * Returns true if they differ and the database needs updating.
 */
export function routinesDiffer(parsed: ParsedRoutine, catalog: CatalogRoutine): boolean {
  // Type
  if (parsed.type !== catalog.type) return true;

  // Parameters — compare count, names, and types (skip dir, catalog doesn't track it)
  if (parsed.parameters.length !== catalog.parameters.length) return true;
  for (let i = 0; i < parsed.parameters.length; i++) {
    if (parsed.parameters[i].name !== catalog.parameters[i].name) return true;
    if (parsed.parameters[i].type.toLowerCase() !== catalog.parameters[i].type.toLowerCase())
      return true;
  }

  // Returns
  if (returnsDiffer(parsed, catalog)) return true;

  // Body
  if (bodyDiffers(parsed.body, catalog.body)) return true;

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
  if (pr.type?.toLowerCase() !== cr.type?.toLowerCase()) return true;

  return false;
}

function bodyDiffers(parsedBody: string | null, catalogBody: string | null): boolean {
  if (parsedBody == null && catalogBody == null) return false;
  if (parsedBody == null || catalogBody == null) return true;
  return bodyHash(parsedBody) !== bodyHash(catalogBody);
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
