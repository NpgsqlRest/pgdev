import { beforeAll, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
CREATE FUNCTION test_schema.multi_word_types(
  _ts timestamp with time zone,
  _label character varying,
  _ratio double precision
) RETURNS void
  LANGUAGE sql AS $$ SELECT 1; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

test("multi-word parameter types match catalog", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === "multi_word_types")!;

  const parsedTypes = parsed.parameters.map((p) => p.type);
  const catalogTypes = match.parameters.map((p) => p.type);
  expect(catalogTypes).toEqual(parsedTypes);
});

test("multi-word type parameter names match catalog", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === "multi_word_types")!;

  const parsedNames = parsed.parameters.map((p) => p.name);
  const catalogNames = match.parameters.map((p) => p.name);
  expect(catalogNames).toEqual(parsedNames);
});
