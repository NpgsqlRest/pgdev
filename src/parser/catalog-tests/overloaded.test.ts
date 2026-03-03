import { beforeAll, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
CREATE FUNCTION test_schema.format_value(_x integer) RETURNS text
  LANGUAGE sql AS $$ SELECT _x::text; $$;

CREATE FUNCTION test_schema.format_value(_x integer, _prefix text) RETURNS text
  LANGUAGE sql AS $$ SELECT _prefix || _x::text; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

test("overloaded functions — both in catalog with different param counts", async () => {
  const parsed = parseRoutines(SQL);
  expect(parsed).toHaveLength(2);

  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const matches = catalog.filter((c) => c.name === "format_value" && c.schema === "test_schema");

  expect(matches.length).toBeGreaterThanOrEqual(2);
  const sorted = matches.sort((a, b) => a.parameters.length - b.parameters.length);
  expect(sorted[0].parameters).toHaveLength(1);
  expect(sorted[0].parameters[0].name).toBe("_x");
  expect(sorted[1].parameters).toHaveLength(2);
  expect(sorted[1].parameters[1].name).toBe("_prefix");
});
