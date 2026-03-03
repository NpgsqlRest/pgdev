import { beforeAll, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
CREATE FUNCTION test_schema.unnamed_params(integer, text) RETURNS void
  LANGUAGE sql AS $$ SELECT 1; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

test("unnamed parameters — count matches catalog", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === "unnamed_params")!;

  expect(match.parameters).toHaveLength(2);
  expect(match.parameters).toHaveLength(parsed.parameters.length);
});

test("unnamed parameters — names are null in both parser and catalog", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === "unnamed_params")!;

  expect(match.parameters[0].name).toBeNull();
  expect(match.parameters[1].name).toBeNull();
  expect(parsed.parameters[0].name).toBeNull();
  expect(parsed.parameters[1].name).toBeNull();
});

test("unnamed parameters — types match catalog", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === "unnamed_params")!;

  const parsedTypes = parsed.parameters.map((p) => p.type);
  const catalogTypes = match.parameters.map((p) => p.type);
  expect(catalogTypes).toEqual(parsedTypes);
});
