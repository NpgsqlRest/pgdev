import { beforeAll, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
CREATE FUNCTION test_schema.__internal_get_value__(_key text) RETURNS text
  LANGUAGE sql AS $$ SELECT _key; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

test("underscore-heavy name — matches catalog with correct parameter", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

  expect(match).toBeDefined();
  expect(match!.parameters).toHaveLength(1);
  expect(match!.parameters[0].name).toBe("_key");
});
