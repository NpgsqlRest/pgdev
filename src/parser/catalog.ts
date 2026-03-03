import { type PgdevConfig } from "../config.ts";
import { runPsqlQuery } from "../commands/exec.ts";

export interface CatalogRoutine {
  schema: string;
  name: string;
  type: "function" | "procedure";
  parameters: { name: string | null; type: string }[];
  returns: { setof: boolean; type: string } | null;
  body: string | null;
  language: string;
  volatility: "immutable" | "stable" | "volatile";
  strict: boolean;
  securityDefiner: boolean;
  parallel: "safe" | "restricted" | "unsafe";
  leakproof: boolean;
  cost: number;
  rows: number;
  config: string[];
  comment: string | null;
}

/** Raw row shape returned by catalogMetadataQuery(). */
export interface CatalogRow {
  schema: string;
  name: string;
  type: string;
  routine_oid: number;
  param_ord: number | null;
  param_name: string | null;
  param_type: string | null;
  return_type: string | null;
  return_setof: boolean;
  body: string | null;
  language: string;
  volatility: string;
  strict: boolean;
  security_definer: boolean;
  parallel: string;
  leakproof: boolean;
  cost: number;
  rows: number;
  config: string[] | null;
  comment: string | null;
}

const VOLATILITY_MAP: Record<string, "immutable" | "stable" | "volatile"> = {
  i: "immutable",
  s: "stable",
  v: "volatile",
};

const PARALLEL_MAP: Record<string, "safe" | "restricted" | "unsafe"> = {
  s: "safe",
  r: "restricted",
  u: "unsafe",
};

/** Build SQL that returns routine metadata from pg_catalog, filtered by schemas. */
export function catalogMetadataQuery(schemas: string[]): string {
  const list = schemas.map((s) => `'${s}'`).join(", ");
  return [
    "SELECT n.nspname AS schema, p.proname AS name,",
    "  CASE p.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure' END AS type,",
    "  p.oid::int AS routine_oid,",
    "  a.ord::int AS param_ord,",
    "  CASE WHEN p.proargnames IS NOT NULL THEN nullif(p.proargnames[a.ord::int], '') ELSE NULL END AS param_name,",
    "  format_type(a.type_oid, NULL) AS param_type,",
    "  format_type(p.prorettype, NULL) AS return_type,",
    "  p.proretset AS return_setof,",
    "  p.prosrc AS body,",
    "  l.lanname AS language,",
    "  p.provolatile AS volatility,",
    "  p.proisstrict AS strict,",
    "  p.prosecdef AS security_definer,",
    "  p.proparallel AS parallel,",
    "  p.proleakproof AS leakproof,",
    "  p.procost::real AS cost,",
    "  p.prorows::real AS rows,",
    "  p.proconfig AS config,",
    "  obj_description(p.oid, 'pg_proc') AS comment",
    "FROM pg_proc p",
    "JOIN pg_namespace n ON n.oid = p.pronamespace",
    "JOIN pg_language l ON l.oid = p.prolang",
    "LEFT JOIN LATERAL unnest(p.proargtypes) WITH ORDINALITY AS a(type_oid, ord) ON true",
    `WHERE n.nspname IN (${list})`,
    "ORDER BY n.nspname, p.proname, p.oid, a.ord",
  ].join("\n");
}

/** Group flat rows into CatalogRoutine[]. Works with both Bun SQL and parsed psql output. */
export function parseCatalogRows(rows: CatalogRow[]): CatalogRoutine[] {
  const map = new Map<number, CatalogRoutine>();

  for (const row of rows) {
    let routine = map.get(row.routine_oid);
    if (!routine) {
      routine = {
        schema: row.schema,
        name: row.name,
        type: row.type as "function" | "procedure",
        parameters: [],
        returns: row.type === "procedure" ? null : { setof: row.return_setof, type: row.return_type! },
        body: row.body,
        language: row.language,
        volatility: VOLATILITY_MAP[row.volatility] ?? "volatile",
        strict: row.strict,
        securityDefiner: row.security_definer,
        parallel: PARALLEL_MAP[row.parallel] ?? "unsafe",
        leakproof: row.leakproof,
        cost: row.cost,
        rows: row.rows,
        config: row.config ?? [],
        comment: row.comment ?? null,
      };
      map.set(row.routine_oid, routine);
    }
    if (row.param_ord != null) {
      routine.parameters.push({
        name: row.param_name,
        type: row.param_type!,
      });
    }
  }

  return [...map.values()];
}

/** Parse psql {key=val,...} array format to string[]. */
function parsePgArray(raw: string): string[] {
  if (!raw || raw === "{}") return [];
  return raw.replace(/^\{/, "").replace(/\}$/, "").split(",");
}

/** Normalize body for comparison: lowercase, strip non-printable, collapse whitespace. */
export function normalizeBody(body: string): string {
  return body
    .toLowerCase()
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Hash a normalized body string (SHA-256, hex). */
export function bodyHash(body: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(normalizeBody(body));
  return hasher.digest("hex");
}

/** Production execution via psql. */
export async function fetchCatalogMetadata(config: PgdevConfig): Promise<CatalogRoutine[]> {
  const schemas = config.project.schemas;
  if (schemas.length === 0) return [];

  const sql = catalogMetadataQuery(schemas);
  const result = await runPsqlQuery(config, sql);
  if (!result.ok) {
    throw new Error(`Catalog query failed: ${result.error}`);
  }

  const rows: CatalogRow[] = result.rows.map((line) => {
    const [
      schema, name, type, oid, ord, paramName, paramType,
      returnType, returnSetof, body, language, volatility,
      strict, securityDefiner, parallel, leakproof, cost, rows, config, comment,
    ] = line.split("|");
    return {
      schema,
      name,
      type,
      routine_oid: Number(oid),
      param_ord: ord ? Number(ord) : null,
      param_name: paramName || null,
      param_type: paramType || null,
      return_type: returnType || null,
      return_setof: returnSetof === "t",
      body: body || null,
      language,
      volatility,
      strict: strict === "t",
      security_definer: securityDefiner === "t",
      parallel,
      leakproof: leakproof === "t",
      cost: Number(cost),
      rows: Number(rows),
      config: parsePgArray(config),
      comment: comment || null,
    };
  });

  return parseCatalogRows(rows);
}
