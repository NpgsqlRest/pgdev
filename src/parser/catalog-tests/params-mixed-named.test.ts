import { beforeAll, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
CREATE FUNCTION test_schema.mixed_names(_first integer, text, _third boolean) RETURNS void
  LANGUAGE sql AS $$ SELECT 1; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

test("mixed named/unnamed — names match catalog", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === "mixed_names")!;

  const parsedNames = parsed.parameters.map((p) => p.name);
  const catalogNames = match.parameters.map((p) => p.name);
  expect(catalogNames).toEqual(parsedNames);
  expect(catalogNames).toEqual(["_first", null, "_third"]);
});
