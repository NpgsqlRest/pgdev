import { beforeAll, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
CREATE FUNCTION test_schema.with_arrays(_ids integer[], _tags text[]) RETURNS void
  LANGUAGE sql AS $$ SELECT 1; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

test("array parameter types match catalog", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === "with_arrays")!;

  const parsedTypes = parsed.parameters.map((p) => p.type);
  const catalogTypes = match.parameters.map((p) => p.type);
  expect(catalogTypes).toEqual(parsedTypes);
});

test("array parameter names match catalog", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === "with_arrays")!;

  const parsedNames = parsed.parameters.map((p) => p.name);
  const catalogNames = match.parameters.map((p) => p.name);
  expect(catalogNames).toEqual(parsedNames);
});
