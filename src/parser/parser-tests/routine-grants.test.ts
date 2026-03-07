import { describe, test, expect } from "bun:test";
import { parseRoutines } from "../routine.ts";
import { grantsToAcl } from "../compare.ts";

describe("parseRoutines — grant extraction", () => {
  test("extracts GRANT EXECUTE on function", () => {
    const sql = `
CREATE FUNCTION app.greet(_name text) RETURNS text
  LANGUAGE sql AS $$ SELECT 'hello ' || _name; $$;

GRANT EXECUTE ON FUNCTION app.greet(text) TO web_user;
`;
    const [r] = parseRoutines(sql, { grants: true });
    expect(r.grants).toHaveLength(1);
    expect(r.grants[0]).toEqual({ privilege: "EXECUTE", grantee: "web_user", isGrant: true });
  });

  test("grants is empty when grants option is false (default)", () => {
    const sql = `
CREATE FUNCTION app.greet(_name text) RETURNS text
  LANGUAGE sql AS $$ SELECT 'hello ' || _name; $$;

GRANT EXECUTE ON FUNCTION app.greet(text) TO web_user;
`;
    const [r] = parseRoutines(sql);
    expect(r.grants).toEqual([]);
  });

  test("extracts REVOKE ALL FROM PUBLIC", () => {
    const sql = `
CREATE FUNCTION app.greet() RETURNS text
  LANGUAGE sql AS $$ SELECT 'hi'; $$;

REVOKE ALL ON FUNCTION app.greet() FROM PUBLIC;
`;
    const [r] = parseRoutines(sql, { grants: true });
    expect(r.grants).toHaveLength(1);
    expect(r.grants[0]).toEqual({ privilege: "ALL", grantee: "PUBLIC", isGrant: false });
  });

  test("extracts multiple GRANT/REVOKE statements", () => {
    const sql = `
CREATE FUNCTION app.greet() RETURNS text
  LANGUAGE sql AS $$ SELECT 'hi'; $$;

REVOKE ALL ON FUNCTION app.greet() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.greet() TO web_user;
GRANT EXECUTE ON FUNCTION app.greet() TO api_role;
`;
    const [r] = parseRoutines(sql, { grants: true });
    expect(r.grants).toHaveLength(3);
    expect(r.grants[0].isGrant).toBe(false);
    expect(r.grants[1].grantee).toBe("web_user");
    expect(r.grants[2].grantee).toBe("api_role");
  });

  test("matches by parameter types (ignores names)", () => {
    const sql = `
CREATE FUNCTION app.add(a integer, b integer) RETURNS integer
  LANGUAGE sql AS $$ SELECT a + b; $$;

GRANT EXECUTE ON FUNCTION app.add(integer, integer) TO calc_role;
`;
    const [r] = parseRoutines(sql, { grants: true });
    expect(r.grants).toHaveLength(1);
    expect(r.grants[0].grantee).toBe("calc_role");
  });

  test("handles pg_dump style with param names in GRANT", () => {
    const sql = `
CREATE FUNCTION app.add(a integer, b integer) RETURNS integer
  LANGUAGE sql AS $$ SELECT a + b; $$;

GRANT EXECUTE ON FUNCTION app.add(a integer, b integer) TO calc_role;
`;
    const [r] = parseRoutines(sql, { grants: true });
    expect(r.grants).toHaveLength(1);
    expect(r.grants[0].grantee).toBe("calc_role");
  });

  test("each routine gets its own grants", () => {
    const sql = `
CREATE FUNCTION app.one() RETURNS int
  LANGUAGE sql AS $$ SELECT 1; $$;

GRANT EXECUTE ON FUNCTION app.one() TO role_a;

CREATE FUNCTION app.two() RETURNS int
  LANGUAGE sql AS $$ SELECT 2; $$;

GRANT EXECUTE ON FUNCTION app.two() TO role_b;
`;
    const results = parseRoutines(sql, { grants: true });
    expect(results[0].grants).toHaveLength(1);
    expect(results[0].grants[0].grantee).toBe("role_a");
    expect(results[1].grants).toHaveLength(1);
    expect(results[1].grants[0].grantee).toBe("role_b");
  });

  test("routine without grants has empty array when grants enabled", () => {
    const sql = `
CREATE FUNCTION app.one() RETURNS int
  LANGUAGE sql AS $$ SELECT 1; $$;

CREATE FUNCTION app.two() RETURNS int
  LANGUAGE sql AS $$ SELECT 2; $$;

GRANT EXECUTE ON FUNCTION app.two() TO role_b;
`;
    const results = parseRoutines(sql, { grants: true });
    expect(results[0].grants).toEqual([]);
    expect(results[1].grants).toHaveLength(1);
  });

  test("handles GRANT on procedure", () => {
    const sql = `
CREATE PROCEDURE app.cleanup()
  LANGUAGE sql AS $$ SELECT 1; $$;

GRANT EXECUTE ON PROCEDURE app.cleanup() TO admin_role;
`;
    const [r] = parseRoutines(sql, { grants: true });
    expect(r.grants).toHaveLength(1);
    expect(r.grants[0].grantee).toBe("admin_role");
  });

  test("case-insensitive GRANT/REVOKE matching", () => {
    const sql = `
CREATE FUNCTION app.greet() RETURNS text
  LANGUAGE sql AS $$ SELECT 'hi'; $$;

grant execute on function app.greet() to web_user;
`;
    const [r] = parseRoutines(sql, { grants: true });
    expect(r.grants).toHaveLength(1);
  });

  test("handles GRANT ALL PRIVILEGES", () => {
    const sql = `
CREATE FUNCTION app.greet() RETURNS text
  LANGUAGE sql AS $$ SELECT 'hi'; $$;

GRANT ALL PRIVILEGES ON FUNCTION app.greet() TO superuser;
`;
    const [r] = parseRoutines(sql, { grants: true });
    expect(r.grants).toHaveLength(1);
    expect(r.grants[0].privilege).toBe("ALL");
  });
});

describe("grantsToAcl", () => {
  test("pg_dump style: REVOKE ALL + explicit GRANTs", () => {
    const grants = [
      { privilege: "ALL" as const, grantee: "PUBLIC", isGrant: false },
      { privilege: "EXECUTE" as const, grantee: "web_user", isGrant: true },
      { privilege: "EXECUTE" as const, grantee: "api_role", isGrant: true },
    ];
    const acl = grantsToAcl(grants, "postgres");
    expect(acl).toEqual(["api_role=X/postgres", "web_user=X/postgres"]);
  });

  test("GRANT to PUBLIC", () => {
    const grants = [
      { privilege: "EXECUTE" as const, grantee: "PUBLIC", isGrant: true },
    ];
    const acl = grantsToAcl(grants, "owner");
    expect(acl).toEqual(["=X/owner"]);
  });

  test("empty grants produces empty ACL", () => {
    expect(grantsToAcl([], "owner")).toEqual([]);
  });
});
