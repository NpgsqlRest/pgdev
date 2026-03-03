import { beforeAll, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
CREATE FUNCTION test_schema.atomic_add(_a int, _b int) RETURNS int
  IMMUTABLE PARALLEL SAFE
  BEGIN ATOMIC;
    SELECT _a + _b;
  END;
`;

beforeAll(async () => {
  await query(SQL);
});

test("BEGIN ATOMIC — name and parameters match catalog", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

  expect(match).toBeDefined();
  expect(match!.parameters).toHaveLength(2);
  expect(match!.parameters[0].name).toBe("_a");
  expect(match!.parameters[1].name).toBe("_b");
});
