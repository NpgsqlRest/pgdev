import { beforeAll, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";
import { expectAttributesMatch } from "./attribute-helper.ts";

const SQL = `
CREATE FUNCTION test_schema.heavy_fn(_x double precision) RETURNS double precision
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT COST 10
  AS $$ SELECT _x * 2; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

test("many attributes — name and parameter match catalog", async () => {
  const [parsed] = parseRoutines(SQL);
  const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
  const catalog = parseCatalogRows(rows);
  const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

  expect(match).toBeDefined();
  expect(match!.parameters).toHaveLength(1);
  expect(match!.parameters[0].name).toBe(parsed.parameters[0].name);
  expect(match!.parameters[0].type).toBe(parsed.parameters[0].type);
  expectAttributesMatch(match!, parsed);
});
