import { beforeAll, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
CREATE FUNCTION test_schema.generate_ids() RETURNS SETOF integer
  LANGUAGE sql AS $$ SELECT generate_series(1, 5); $$;
`;

beforeAll(async () => {
  await query(SQL);
});

test("RETURNS SETOF — name matches catalog, 0 parameters", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

  expect(match).toBeDefined();
  expect(match!.type).toBe("function");
  expect(match!.parameters).toHaveLength(0);
  expect(match!.returns).toEqual({ setof: true, type: "integer" });
});
