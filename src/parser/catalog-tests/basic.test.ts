import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";
import { expectAttributesMatch } from "./attribute-helper.ts";

const SQL = `
CREATE FUNCTION test_schema.greet(_name text) RETURNS text
  LANGUAGE sql AS $$ SELECT 'hello ' || _name; $$;

CREATE PROCEDURE test_schema.cleanup()
  LANGUAGE sql AS $$ SELECT 1; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("basic function and procedure", () => {
  test("names and types match catalog", async () => {
    const parsed = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);

    for (const r of parsed) {
      const match = catalog.find((c) => c.name === r.name && c.schema === r.schema);
      expect(match).toBeDefined();
      expect(match!.type).toBe(r.type);
    }
  });

  test("greet has 1 parameter named _name", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "greet")!;

    expect(match.parameters).toHaveLength(parsed.parameters.length);
    expect(match.parameters[0].name).toBe(parsed.parameters[0].name);
  });

  test("cleanup has 0 parameters", async () => {
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "cleanup")!;

    expect(match.parameters).toHaveLength(0);
  });

  test("greet returns text", async () => {
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "greet")!;

    expect(match.returns).toEqual({ setof: false, type: "text" });
  });

  test("procedure has null returns", async () => {
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "cleanup")!;

    expect(match.returns).toBeNull();
  });

  test("function has default attributes", async () => {
    const parsed = parseRoutines(SQL);
    const greet = parsed.find((r) => r.name === "greet")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "greet")!;

    expectAttributesMatch(match, greet);
  });
});
