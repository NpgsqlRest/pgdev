import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";
import { commentsDiffer } from "../compare.ts";

const SQL = `
CREATE FUNCTION test_schema.greet_comment(_name text) RETURNS text
  LANGUAGE sql AS $$ SELECT 'hello ' || _name; $$;

COMMENT ON FUNCTION test_schema.greet_comment(text) IS 'Say hello';

CREATE FUNCTION test_schema.no_comment_fn() RETURNS int
  LANGUAGE sql AS $$ SELECT 42; $$;

CREATE PROCEDURE test_schema.do_cleanup_comment()
  LANGUAGE sql AS $$ SELECT 1; $$;

COMMENT ON PROCEDURE test_schema.do_cleanup_comment() IS 'Clean up stale data';
`;

beforeAll(async () => {
  await query(SQL);
});

describe("comment — catalog integration", () => {
  test("function comment matches catalog", async () => {
    const parsed = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);

    const pGreet = parsed.find((r) => r.name === "greet_comment")!;
    const cGreet = catalog.find((c) => c.name === "greet_comment")!;

    expect(pGreet.comment).toBe("Say hello");
    expect(cGreet.comment).toBe("Say hello");
    expect(commentsDiffer(pGreet, cGreet)).toBe(false);
  });

  test("function without comment has null in catalog", async () => {
    const parsed = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);

    const pNone = parsed.find((r) => r.name === "no_comment_fn")!;
    const cNone = catalog.find((c) => c.name === "no_comment_fn")!;

    expect(pNone.comment).toBeNull();
    expect(cNone.comment).toBeNull();
    expect(commentsDiffer(pNone, cNone)).toBe(false);
  });

  test("procedure comment matches catalog", async () => {
    const parsed = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);

    const pCleanup = parsed.find((r) => r.name === "do_cleanup_comment")!;
    const cCleanup = catalog.find((c) => c.name === "do_cleanup_comment")!;

    expect(pCleanup.comment).toBe("Clean up stale data");
    expect(cCleanup.comment).toBe("Clean up stale data");
    expect(commentsDiffer(pCleanup, cCleanup)).toBe(false);
  });

  test("commentsDiffer detects mismatch", async () => {
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const cGreet = catalog.find((c) => c.name === "greet_comment")!;

    // Parse SQL with different comment text
    const altSql = `
CREATE FUNCTION test_schema.greet_comment(_name text) RETURNS text
  LANGUAGE sql AS $$ SELECT 'hello ' || _name; $$;

COMMENT ON FUNCTION test_schema.greet_comment(text) IS 'Different comment';
`;
    const [pAlt] = parseRoutines(altSql);

    expect(commentsDiffer(pAlt, cGreet)).toBe(true);
  });

  test("commentsDiffer detects file has comment but db does not", async () => {
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const cNone = catalog.find((c) => c.name === "no_comment_fn")!;

    // Parse SQL with comment for the no-comment function
    const altSql = `
CREATE FUNCTION test_schema.no_comment_fn() RETURNS int
  LANGUAGE sql AS $$ SELECT 42; $$;

COMMENT ON FUNCTION test_schema.no_comment_fn() IS 'Now has comment';
`;
    const [pAlt] = parseRoutines(altSql);

    expect(commentsDiffer(pAlt, cNone)).toBe(true);
  });

  test("commentsDiffer detects db has comment but file does not", async () => {
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const cGreet = catalog.find((c) => c.name === "greet_comment")!;

    // Parse SQL without the COMMENT ON
    const altSql = `
CREATE FUNCTION test_schema.greet_comment(_name text) RETURNS text
  LANGUAGE sql AS $$ SELECT 'hello ' || _name; $$;
`;
    const [pAlt] = parseRoutines(altSql);

    expect(commentsDiffer(pAlt, cGreet)).toBe(true);
  });
});
