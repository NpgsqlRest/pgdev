import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";
import { routinesDiffer } from "../compare.ts";
import { expectAttributesMatch } from "./attribute-helper.ts";

// Attributes in a scrambled order (COST before LANGUAGE, ROWS before RETURNS, etc.)
// Also tests ROWS with SETOF and SET configuration parameters
const SQL = `
CREATE FUNCTION test_schema.scrambled_attrs(
  _threshold double precision,
  _tag text DEFAULT 'default'
)
RETURNS SETOF integer
COST 42
ROWS 500
STRICT
PARALLEL RESTRICTED
STABLE
LANGUAGE sql
SET search_path = pg_catalog
SET statement_timeout TO '30s'
AS $$
  SELECT generate_series(1, _threshold::integer);
$$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("scrambled attribute order with ROWS and SET", () => {
  test("parser and catalog agree", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

    expect(match).toBeDefined();
    expect(routinesDiffer(parsed, match!)).toBe(false);
  });

  test("attributes match catalog — COST, ROWS, SET", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name)!;

    expectAttributesMatch(match, parsed);
  });

  test("returns setof integer", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name)!;

    expect(match.returns).toEqual({ setof: parsed.returns!.setof, type: parsed.returns!.type! });
  });
});
