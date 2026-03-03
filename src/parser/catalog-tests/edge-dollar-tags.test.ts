import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, bodyHash, type CatalogRow } from "../catalog.ts";
import { routinesDiffer } from "../compare.ts";
import { expectAttributesMatch } from "./attribute-helper.ts";

// Custom dollar-quote tags, including one with nested $$ inside the body
const SQL = `
CREATE FUNCTION test_schema.dollar_tag_fn(_input text)
RETURNS text
LANGUAGE plpgsql
AS $fn_body$
declare
  _result text;
begin
  -- This body contains $$ which would confuse a naive parser
  _result := '$$not a quote$$';
  return _input || _result;
end;
$fn_body$;

CREATE FUNCTION test_schema.weird_tag_123(_n integer)
RETURNS integer
LANGUAGE sql
STABLE
AS $_x99$
  SELECT _n * 2;
$_x99$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("custom dollar-quote tags", () => {
  test("fn_body tag — parser and catalog agree", async () => {
    const parsed = parseRoutines(SQL);
    const fn = parsed.find((r) => r.name === "dollar_tag_fn")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "dollar_tag_fn")!;

    expect(match).toBeDefined();
    expect(routinesDiffer(fn, match)).toBe(false);
  });

  test("fn_body tag — body with nested $$ hashes match", async () => {
    const parsed = parseRoutines(SQL);
    const fn = parsed.find((r) => r.name === "dollar_tag_fn")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "dollar_tag_fn")!;

    expect(bodyHash(fn.body!)).toBe(bodyHash(match.body!));
  });

  test("numeric tag — parser and catalog agree", async () => {
    const parsed = parseRoutines(SQL);
    const fn = parsed.find((r) => r.name === "weird_tag_123")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "weird_tag_123")!;

    expect(match).toBeDefined();
    expect(routinesDiffer(fn, match)).toBe(false);
  });

  test("numeric tag — attributes match", async () => {
    const parsed = parseRoutines(SQL);
    const fn = parsed.find((r) => r.name === "weird_tag_123")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "weird_tag_123")!;

    expectAttributesMatch(match, fn);
  });
});
