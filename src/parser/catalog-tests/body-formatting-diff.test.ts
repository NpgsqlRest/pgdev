import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, bodyHash, normalizeBody, type CatalogRow } from "../catalog.ts";

// Script uses extra whitespace and different indentation than what PG stores
const SQL = `
create function test_schema.add_amounts(
    _a numeric,
    _b numeric
)
returns numeric
immutable
language sql as
$$
    SELECT
        _a
        +
        _b;
$$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("body comparison — formatting differences", () => {
  test("body hashes match despite whitespace differences", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

    expect(match).toBeDefined();
    expect(parsed.body).toBeDefined();
    expect(match!.body).toBeDefined();
    expect(bodyHash(parsed.body!)).toBe(bodyHash(match!.body!));
  });

  test("normalizeBody lowercases and trims but preserves whitespace structure", () => {
    const a = "  SELECT\n    _a\n    +\n    _b;  ";
    const b = "select\n    _a\n    +\n    _b;";
    expect(normalizeBody(a)).toBe(normalizeBody(b));
    // Different whitespace structure is detected
    expect(normalizeBody(a)).not.toBe(normalizeBody("select _a + _b;"));
  });

  test("different bodies produce different hashes", () => {
    const a = "select _a + _b;";
    const b = "select _a - _b;";
    expect(bodyHash(a)).not.toBe(bodyHash(b));
  });
});
