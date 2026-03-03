import { beforeAll, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
CREATE FUNCTION test_schema.fn_alpha() RETURNS void
  LANGUAGE sql AS $$ SELECT 1; $$;

CREATE FUNCTION test_schema.fn_beta(_x int) RETURNS int
  LANGUAGE sql AS $$ SELECT _x; $$;

CREATE PROCEDURE test_schema.proc_gamma()
  LANGUAGE sql AS $$ SELECT 1; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

test("all routines exist in catalog with correct types", async () => {
  const parsed = parseRoutines(SQL);
  expect(parsed).toHaveLength(3);

  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);

  for (const r of parsed) {
    const match = catalog.find((c) => c.name === r.name && c.schema === r.schema);
    expect(match).toBeDefined();
    expect(match!.type).toBe(r.type);
  }
});

test("each routine has correct parameter count", async () => {
  const parsed = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);

  for (const r of parsed) {
    const match = catalog.find((c) => c.name === r.name && c.schema === r.schema)!;
    expect(match.parameters).toHaveLength(r.parameters.length);
  }
});
