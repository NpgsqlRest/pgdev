import { beforeAll, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
create function test_schema.lowercase_fn() returns void
  language sql as $$ select 1; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

test("lowercase CREATE FUNCTION — name matches catalog, 0 parameters", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

  expect(match).toBeDefined();
  expect(match!.type).toBe("function");
  expect(match!.parameters).toHaveLength(0);
});
