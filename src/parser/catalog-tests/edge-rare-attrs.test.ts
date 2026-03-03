import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";
import { routinesDiffer } from "../compare.ts";
import { expectAttributesMatch } from "./attribute-helper.ts";

// EXTERNAL SECURITY DEFINER (rare alias), LEAKPROOF, RETURNS NULL ON NULL INPUT
const SQL = `
CREATE FUNCTION test_schema.rare_attrs_fn(_x integer)
RETURNS integer
LANGUAGE sql
EXTERNAL SECURITY DEFINER
LEAKPROOF
RETURNS NULL ON NULL INPUT
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT _x; $$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("rare attribute combinations", () => {
  test("parser and catalog agree", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

    expect(match).toBeDefined();
    expect(routinesDiffer(parsed, match!)).toBe(false);
  });

  test("EXTERNAL SECURITY DEFINER maps to securityDefiner=true", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name)!;

    expectAttributesMatch(match, parsed);
    // Verify the rare variants explicitly resolved correctly
    expect(match.securityDefiner).toBe(true);
    expect(match.leakproof).toBe(true);
    expect(match.strict).toBe(true);
  });
});
