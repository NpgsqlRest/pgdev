import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, bodyHash, type CatalogRow } from "../catalog.ts";
import { routinesDiffer } from "../compare.ts";
import { expectAttributesMatch } from "./attribute-helper.ts";

// Everything crammed onto as few lines as possible — valid SQL, horrible to read
const SQL = `CREATE FUNCTION test_schema.oneliner_fn(_a integer,_b integer,_c text DEFAULT 'x')RETURNS text LANGUAGE sql IMMUTABLE STRICT COST 5 AS $$ SELECT _c||(_a+_b)::text; $$;CREATE PROCEDURE test_schema.oneliner_proc(_id integer)LANGUAGE sql AS $$ SELECT _id; $$;`;

beforeAll(async () => {
  await query(SQL);
});

describe("everything crammed on one line", () => {
  test("function — parser and catalog agree", async () => {
    const parsed = parseRoutines(SQL);
    const fn = parsed.find((r) => r.name === "oneliner_fn")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "oneliner_fn")!;

    expect(match).toBeDefined();
    expect(routinesDiffer(fn, match)).toBe(false);
  });

  test("function — attributes match", async () => {
    const parsed = parseRoutines(SQL);
    const fn = parsed.find((r) => r.name === "oneliner_fn")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "oneliner_fn")!;

    expectAttributesMatch(match, fn);
  });

  test("function — body hashes match", async () => {
    const parsed = parseRoutines(SQL);
    const fn = parsed.find((r) => r.name === "oneliner_fn")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "oneliner_fn")!;

    expect(bodyHash(fn.body!)).toBe(bodyHash(match.body!));
  });

  test("procedure — parser and catalog agree", async () => {
    const parsed = parseRoutines(SQL);
    const proc = parsed.find((r) => r.name === "oneliner_proc")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "oneliner_proc")!;

    expect(match).toBeDefined();
    expect(routinesDiffer(proc, match)).toBe(false);
  });

  test("procedure — attributes match", async () => {
    const parsed = parseRoutines(SQL);
    const proc = parsed.find((r) => r.name === "oneliner_proc")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "oneliner_proc")!;

    expectAttributesMatch(match, proc);
  });
});
