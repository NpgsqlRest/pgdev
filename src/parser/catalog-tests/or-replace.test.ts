import { beforeAll, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
CREATE OR REPLACE FUNCTION test_schema.replaceable() RETURNS void
  LANGUAGE sql AS $$ SELECT 1; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

test("OR REPLACE — name matches catalog, 0 parameters", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

  expect(match).toBeDefined();
  expect(match!.parameters).toHaveLength(parsed.parameters.length);
});
