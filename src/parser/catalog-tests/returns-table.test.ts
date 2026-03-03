import { beforeAll, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
CREATE FUNCTION test_schema.list_items() RETURNS TABLE(id integer, label text)
  LANGUAGE sql AS $$ SELECT 1, 'a'::text; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

test("RETURNS TABLE — name matches catalog, 0 input parameters", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

  expect(match).toBeDefined();
  expect(match!.type).toBe("function");
  expect(match!.parameters).toHaveLength(0);
  expect(match!.returns).toEqual({ setof: true, type: "record" });
});
