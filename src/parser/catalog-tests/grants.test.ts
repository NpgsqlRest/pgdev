import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";
import { grantsDiffer, grantsToAcl } from "../compare.ts";

const SETUP_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgdev_test_role') THEN
    CREATE ROLE pgdev_test_role;
  END IF;
END $$;
`;

const SQL = `
CREATE FUNCTION test_schema.grant_fn() RETURNS text
  LANGUAGE sql AS $$ SELECT 'granted'; $$;

REVOKE ALL ON FUNCTION test_schema.grant_fn() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION test_schema.grant_fn() TO pgdev_test_role;
`;

const SQL_NO_GRANTS = `
CREATE FUNCTION test_schema.no_grant_fn() RETURNS int
  LANGUAGE sql AS $$ SELECT 1; $$;
`;

beforeAll(async () => {
  await query(SETUP_SQL);
  await query(SQL);
  await query(SQL_NO_GRANTS);
});

describe("grants — catalog integration", () => {
  test("catalog has ACL for function with grants", async () => {
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "grant_fn")!;

    expect(match.acl).not.toBeNull();
    expect(match.acl!.length).toBeGreaterThan(0);
    // Should contain the test role grant
    const hasTestRole = match.acl!.some((a) => a.includes("pgdev_test_role"));
    expect(hasTestRole).toBe(true);
  });

  test("catalog has null ACL for function with default permissions", async () => {
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "no_grant_fn")!;

    // Default permissions — proacl is NULL
    expect(match.acl).toBeNull();
  });

  test("grantsDiffer returns false when grants match", async () => {
    const parsed = parseRoutines(SQL, { grants: true });
    const pGrantFn = parsed.find((r) => r.name === "grant_fn")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const cGrantFn = catalog.find((c) => c.name === "grant_fn")!;

    expect(grantsDiffer(pGrantFn, cGrantFn)).toBe(false);
  });

  test("grantsDiffer returns false for no-grant function (both sides default)", async () => {
    const parsed = parseRoutines(SQL_NO_GRANTS, { grants: true });
    const pNoGrant = parsed.find((r) => r.name === "no_grant_fn")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const cNoGrant = catalog.find((c) => c.name === "no_grant_fn")!;

    expect(grantsDiffer(pNoGrant, cNoGrant)).toBe(false);
  });

  test("grantsDiffer detects when file has grants but db does not", async () => {
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const cNoGrant = catalog.find((c) => c.name === "no_grant_fn")!;

    const altSql = `
CREATE FUNCTION test_schema.no_grant_fn() RETURNS int
  LANGUAGE sql AS $$ SELECT 1; $$;

REVOKE ALL ON FUNCTION test_schema.no_grant_fn() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION test_schema.no_grant_fn() TO pgdev_test_role;
`;
    const [pAlt] = parseRoutines(altSql, { grants: true });
    expect(grantsDiffer(pAlt, cNoGrant)).toBe(true);
  });

  test("grantsDiffer detects when db has grants but file does not", async () => {
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const cGrantFn = catalog.find((c) => c.name === "grant_fn")!;

    const altSql = `
CREATE FUNCTION test_schema.grant_fn() RETURNS text
  LANGUAGE sql AS $$ SELECT 'granted'; $$;
`;
    const [pAlt] = parseRoutines(altSql, { grants: true });
    expect(grantsDiffer(pAlt, cGrantFn)).toBe(true);
  });
});
