import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
CREATE FUNCTION test_schema.compute(_a integer, _b integer, _op text DEFAULT '+') RETURNS integer
  LANGUAGE sql AS $$ SELECT _a + _b; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("function with params and default", () => {
  test("name matches catalog", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);
    expect(match).toBeDefined();
  });

  test("parameter count matches", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "compute")!;
    expect(match.parameters).toHaveLength(parsed.parameters.length);
  });

  test("parameter names match", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "compute")!;

    const parsedNames = parsed.parameters.map((p) => p.name);
    const catalogNames = match.parameters.map((p) => p.name);
    expect(catalogNames).toEqual(parsedNames);
  });

  test("parameter types match", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "compute")!;

    const parsedTypes = parsed.parameters.map((p) => p.type);
    const catalogTypes = match.parameters.map((p) => p.type);
    expect(catalogTypes).toEqual(parsedTypes);
  });
});
