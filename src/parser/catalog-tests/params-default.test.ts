import { beforeAll, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
CREATE FUNCTION test_schema.with_defaults(
  _x integer DEFAULT 0,
  _label text DEFAULT 'none',
  _active boolean DEFAULT true
) RETURNS void
  LANGUAGE sql AS $$ SELECT 1; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

test("params with defaults — count matches catalog", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === "with_defaults")!;

  expect(match.parameters).toHaveLength(3);
  expect(match.parameters).toHaveLength(parsed.parameters.length);
});

test("params with defaults — names match catalog", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === "with_defaults")!;

  const parsedNames = parsed.parameters.map((p) => p.name);
  const catalogNames = match.parameters.map((p) => p.name);
  expect(catalogNames).toEqual(parsedNames);
});

test("params with defaults — types match catalog", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === "with_defaults")!;

  const parsedTypes = parsed.parameters.map((p) => p.type);
  const catalogTypes = match.parameters.map((p) => p.type);
  expect(catalogTypes).toEqual(parsedTypes);
});
