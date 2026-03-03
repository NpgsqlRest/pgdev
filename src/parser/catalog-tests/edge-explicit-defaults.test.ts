import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";
import { routinesDiffer } from "../compare.ts";
import { expectAttributesMatch } from "./attribute-helper.ts";

// Every default attribute explicitly stated — PG should store the same as if omitted
const SQL = `
CREATE FUNCTION test_schema.all_defaults_fn(_x integer)
RETURNS integer
LANGUAGE sql
VOLATILE
CALLED ON NULL INPUT
SECURITY INVOKER
PARALLEL UNSAFE
NOT LEAKPROOF
COST 100
AS $$ SELECT _x; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("all PG defaults explicitly stated", () => {
  test("parser and catalog agree", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

    expect(match).toBeDefined();
    expect(routinesDiffer(parsed, match!)).toBe(false);
  });

  test("attributes match catalog — all explicit defaults", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name)!;

    expectAttributesMatch(match, parsed);
  });
});
