import { describe, test, expect } from "bun:test";
import { parseRoutines } from "../routine.ts";
import { formatRoutine, formatRoutines, isApiRoutine, getGroupDir, DEFAULT_SKIP_PREFIXES, DEFAULT_FORMAT_OPTIONS, type FormatOptions } from "../formatter.ts";

// Real pg_dump output for a procedure with defaults, comment, and attributes
const PG_DUMP_PROCEDURE = `
CREATE PROCEDURE mathmodule.auth_logout(IN _analytics jsonb DEFAULT '{}'::jsonb, IN _user_id text DEFAULT (NULL::text = NULL::text), IN _user_name text DEFAULT (NULL::text = NULL::text), IN _ip_address text DEFAULT (NULL::text = NULL::text))
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
begin
    _analytics = coalesce(_analytics, '{}'::jsonb) || jsonb_build_object('ip', _ip_address, 'user_id', _user_id, 'username', _user_name);

    insert into mathmodule.auth_log (type, success, message, username, analytics)
    values ('O', true, 'logout successful', _user_name, _analytics);
end;
$$;

COMMENT ON PROCEDURE mathmodule.auth_logout(IN _analytics jsonb, IN _user_id text, IN _user_name text, IN _ip_address text) IS 'HTTP POST
logout
authorize
security_sensitive
tsclient_module = user';
`;

// Real pg_dump output for a function with returns, no defaults
const PG_DUMP_FUNCTION = `
CREATE FUNCTION mathmodule.compute_value(_computed_spec jsonb, _things jsonb) RETURNS double precision
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $$
declare
    _result double precision = 0;
begin
    return _result;
end;
$$;
`;

// Function with RETURNS SETOF and a DEFAULT NULL::type
const PG_DUMP_SETOF = `
CREATE FUNCTION mathmodule.get_intervals(_cache text DEFAULT NULL::text) RETURNS SETOF text
    LANGUAGE sql IMMUTABLE
    AS $$
values ('5 minutes'), ('1 hour')
$$;

COMMENT ON FUNCTION mathmodule.get_intervals(_cache text) IS 'HTTP GET
Cache-Control: public, max-age=31536000, immutable
authorize';
`;

describe("formatRoutine — default options", () => {
  test("procedure with defaults, comment, and attributes", () => {
    const [parsed] = parseRoutines(PG_DUMP_PROCEDURE);
    const result = formatRoutine(parsed);

    expect(result).toContain("create procedure mathmodule.auth_logout(");
    // Multiline params
    expect(result).toContain("    _analytics jsonb = '{}'");
    expect(result).toContain("    _user_id text = null,");
    expect(result).toContain("    _user_name text = null,");
    expect(result).toContain("    _ip_address text = null");
    // No IN direction (omitted by default)
    expect(result).not.toContain("in _analytics");
    expect(result).not.toContain("IN _analytics");
    // Attributes on own lines
    expect(result).toContain("security definer\n");
    expect(result).toContain("language plpgsql\n");
    // Body
    expect(result).toContain("as\n$$");
    expect(result).toContain("end;\n$$;");
    // Comment with types-only signature
    expect(result).toContain("comment on procedure mathmodule.auth_logout(jsonb, text, text, text)");
    expect(result).toContain("is 'HTTP POST");
  });

  test("function with returns, no defaults", () => {
    const [parsed] = parseRoutines(PG_DUMP_FUNCTION);
    const result = formatRoutine(parsed);

    expect(result).toContain("create function mathmodule.compute_value(");
    expect(result).toContain("    _computed_spec jsonb,");
    expect(result).toContain("    _things jsonb");
    expect(result).toContain("returns double precision");
    expect(result).toContain("immutable\n");
    expect(result).toContain("parallel safe\n");
    expect(result).toContain("language plpgsql\n");
    expect(result).not.toContain("COMMENT"); // no comment
  });

  test("function with SETOF return and DEFAULT NULL::type", () => {
    const [parsed] = parseRoutines(PG_DUMP_SETOF);
    const result = formatRoutine(parsed);

    expect(result).toContain("_cache text = null");
    expect(result).toContain("returns setof text");
    expect(result).toContain("comment on function mathmodule.get_intervals(text)");
  });
});

describe("formatRoutine — option variations", () => {
  test("uppercase keywords", () => {
    const [parsed] = parseRoutines(PG_DUMP_FUNCTION);
    const result = formatRoutine(parsed, { lowercase: false });

    expect(result).toContain("CREATE FUNCTION");
    expect(result).toContain("RETURNS DOUBLE PRECISION");
    expect(result).toContain("LANGUAGE PLPGSQL");
    expect(result).toContain("IMMUTABLE");
  });

  test("inline params", () => {
    const [parsed] = parseRoutines(PG_DUMP_FUNCTION);
    const result = formatRoutine(parsed, { paramStyle: "inline" });

    expect(result).toContain("create function mathmodule.compute_value(_computed_spec jsonb, _things jsonb)");
  });

  test("inline attributes", () => {
    const [parsed] = parseRoutines(PG_DUMP_FUNCTION);
    const result = formatRoutine(parsed, { attributeStyle: "inline" });

    // Returns + attributes all on the closing line
    expect(result).toContain(") returns double precision immutable parallel safe language plpgsql");
  });

  test("keep IN direction", () => {
    const [parsed] = parseRoutines(PG_DUMP_PROCEDURE);
    const result = formatRoutine(parsed, { omitDefaultDirection: false });

    expect(result).toContain("in _analytics jsonb");
  });

  test("don't simplify defaults", () => {
    const [parsed] = parseRoutines(PG_DUMP_PROCEDURE);
    const result = formatRoutine(parsed, { simplifyDefaults: false });

    expect(result).toContain("= '{}'::jsonb");
    expect(result).toContain("= (NULL::text = NULL::text)");
  });

  test("full comment signature", () => {
    const [parsed] = parseRoutines(PG_DUMP_PROCEDURE);
    const result = formatRoutine(parsed, { commentSignatureStyle: "full" });

    expect(result).toContain("comment on procedure mathmodule.auth_logout(_analytics jsonb, _user_id text, _user_name text, _ip_address text)");
  });

  test("custom indent", () => {
    const [parsed] = parseRoutines(PG_DUMP_FUNCTION);
    const result = formatRoutine(parsed, { indent: "  " });

    expect(result).toContain("  _computed_spec jsonb");
  });
});

describe("simplifyDefaults", () => {
  test("(NULL::text = NULL::text) → null", () => {
    const sql = `CREATE FUNCTION f(_a text DEFAULT (NULL::text = NULL::text)) RETURNS void LANGUAGE sql AS $$ $$;`;
    const [parsed] = parseRoutines(sql);
    const result = formatRoutine(parsed);
    expect(result).toContain("_a text = null");
  });

  test("NULL::text → null", () => {
    const sql = `CREATE FUNCTION f(_a text DEFAULT NULL::text) RETURNS void LANGUAGE sql AS $$ $$;`;
    const [parsed] = parseRoutines(sql);
    const result = formatRoutine(parsed);
    expect(result).toContain("_a text = null");
  });

  test("'{}'::jsonb → '{}'", () => {
    const sql = `CREATE FUNCTION f(_a jsonb DEFAULT '{}'::jsonb) RETURNS void LANGUAGE sql AS $$ $$;`;
    const [parsed] = parseRoutines(sql);
    const result = formatRoutine(parsed);
    expect(result).toContain("_a jsonb = '{}'");
  });

  test("preserves non-simplifiable defaults", () => {
    const sql = `CREATE FUNCTION f(_a int DEFAULT 42) RETURNS void LANGUAGE sql AS $$ $$;`;
    const [parsed] = parseRoutines(sql);
    const result = formatRoutine(parsed);
    expect(result).toContain("_a int = 42");
  });
});

describe("formatRoutines — multiple routines", () => {
  test("formats multiple routines separated by blank line", () => {
    const input = PG_DUMP_FUNCTION + "\n" + PG_DUMP_SETOF;
    const parsed = parseRoutines(input);
    const result = formatRoutines(parsed);

    expect(parsed.length).toBe(2);
    expect(result).toContain("create function mathmodule.compute_value");
    expect(result).toContain("create function mathmodule.get_intervals");
  });
});

describe("parseRoutines preserves defaults", () => {
  test("DEFAULT keyword", () => {
    const sql = `CREATE FUNCTION f(_a int DEFAULT 42) RETURNS void LANGUAGE sql AS $$ $$;`;
    const [parsed] = parseRoutines(sql);
    expect(parsed.parameters[0].default).toBe("42");
  });

  test("= shorthand", () => {
    const sql = `CREATE FUNCTION f(_a int = 42) RETURNS void LANGUAGE sql AS $$ $$;`;
    const [parsed] = parseRoutines(sql);
    expect(parsed.parameters[0].default).toBe("42");
  });

  test("NULL::type default", () => {
    const sql = `CREATE FUNCTION f(_a text DEFAULT NULL::text) RETURNS void LANGUAGE sql AS $$ $$;`;
    const [parsed] = parseRoutines(sql);
    expect(parsed.parameters[0].default).toBe("NULL::text");
  });

  test("complex default expression", () => {
    const sql = `CREATE FUNCTION f(_a jsonb DEFAULT '{}'::jsonb) RETURNS void LANGUAGE sql AS $$ $$;`;
    const [parsed] = parseRoutines(sql);
    expect(parsed.parameters[0].default).toBe("'{}'::jsonb");
  });

  test("no default → null", () => {
    const sql = `CREATE FUNCTION f(_a int) RETURNS void LANGUAGE sql AS $$ $$;`;
    const [parsed] = parseRoutines(sql);
    expect(parsed.parameters[0].default).toBeNull();
  });

  test("(NULL::type = NULL::type) pg_dump pattern", () => {
    const sql = `CREATE PROCEDURE p(_a text DEFAULT (NULL::text = NULL::text)) LANGUAGE sql AS $$ $$;`;
    const [parsed] = parseRoutines(sql);
    expect(parsed.parameters[0].default).toBe("(NULL::text = NULL::text)");
  });
});

describe("dropBeforeCreate", () => {
  test("adds DROP IF EXISTS before CREATE by default", () => {
    const [parsed] = parseRoutines(PG_DUMP_FUNCTION);
    const result = formatRoutine(parsed);

    expect(result).toContain("drop function if exists mathmodule.compute_value(jsonb, jsonb);");
    expect(result).toContain("create function mathmodule.compute_value(");
    // DROP should come before CREATE
    const dropIdx = result.indexOf("drop function");
    const createIdx = result.indexOf("create function");
    expect(dropIdx).toBeLessThan(createIdx);
  });

  test("adds DROP for procedure", () => {
    const [parsed] = parseRoutines(PG_DUMP_PROCEDURE);
    const result = formatRoutine(parsed);

    expect(result).toContain("drop procedure if exists mathmodule.auth_logout(jsonb, text, text, text);");
  });

  test("uppercase DROP when lowercase: false", () => {
    const [parsed] = parseRoutines(PG_DUMP_FUNCTION);
    const result = formatRoutine(parsed, { lowercase: false });

    expect(result).toContain("DROP FUNCTION IF EXISTS mathmodule.compute_value(JSONB, JSONB);");
  });

  test("no DROP when dropBeforeCreate: false", () => {
    const [parsed] = parseRoutines(PG_DUMP_FUNCTION);
    const result = formatRoutine(parsed, { dropBeforeCreate: false });

    expect(result).not.toContain("drop function if exists");
    expect(result).not.toContain("DROP FUNCTION IF EXISTS");
    expect(result).toContain("create function");
  });
});

describe("createOrReplace", () => {
  test("uses CREATE OR REPLACE when enabled", () => {
    const [parsed] = parseRoutines(PG_DUMP_FUNCTION);
    const result = formatRoutine(parsed, { createOrReplace: true });

    expect(result).toContain("create or replace function mathmodule.compute_value(");
  });

  test("uses CREATE OR REPLACE for procedure", () => {
    const [parsed] = parseRoutines(PG_DUMP_PROCEDURE);
    const result = formatRoutine(parsed, { createOrReplace: true });

    expect(result).toContain("create or replace procedure mathmodule.auth_logout(");
  });

  test("uppercase CREATE OR REPLACE", () => {
    const [parsed] = parseRoutines(PG_DUMP_FUNCTION);
    const result = formatRoutine(parsed, { createOrReplace: true, lowercase: false });

    expect(result).toContain("CREATE OR REPLACE FUNCTION");
  });

  test("no OR REPLACE by default", () => {
    const [parsed] = parseRoutines(PG_DUMP_FUNCTION);
    const result = formatRoutine(parsed);

    expect(result).not.toContain("or replace");
    expect(result).not.toContain("OR REPLACE");
  });

  test("both dropBeforeCreate and createOrReplace", () => {
    const [parsed] = parseRoutines(PG_DUMP_FUNCTION);
    const result = formatRoutine(parsed, { dropBeforeCreate: true, createOrReplace: true });

    expect(result).toContain("drop function if exists");
    expect(result).toContain("create or replace function");
  });
});

describe("isApiRoutine", () => {
  test("routine with HTTP at start of comment is public", () => {
    const [parsed] = parseRoutines(PG_DUMP_SETOF);
    expect(isApiRoutine([parsed])).toBe(true);
  });

  test("procedure with HTTP at start of comment is public", () => {
    const [parsed] = parseRoutines(PG_DUMP_PROCEDURE);
    expect(isApiRoutine([parsed])).toBe(true);
  });

  test("routine without comment is private", () => {
    const [parsed] = parseRoutines(PG_DUMP_FUNCTION);
    expect(isApiRoutine([parsed])).toBe(false);
  });

  test("routine with non-HTTP comment is private", () => {
    const sql = `CREATE FUNCTION f(_a int) RETURNS void LANGUAGE sql AS $$ $$;\nCOMMENT ON FUNCTION f(int) IS 'some internal helper';`;
    const [parsed] = parseRoutines(sql);
    expect(isApiRoutine([parsed])).toBe(false);
  });

  test("HTTP on a new line in comment is public", () => {
    const sql = `CREATE FUNCTION f(_a int) RETURNS void LANGUAGE sql AS $$ $$;\nCOMMENT ON FUNCTION f(int) IS 'some prefix\nHTTP GET';`;
    const [parsed] = parseRoutines(sql);
    expect(isApiRoutine([parsed])).toBe(true);
  });

  test("HTTP mid-line is not public", () => {
    const sql = `CREATE FUNCTION f(_a int) RETURNS void LANGUAGE sql AS $$ $$;\nCOMMENT ON FUNCTION f(int) IS 'uses HTTP internally';`;
    const [parsed] = parseRoutines(sql);
    expect(isApiRoutine([parsed])).toBe(false);
  });
});

describe("getGroupDir", () => {
  const defaults = new Set(DEFAULT_SKIP_PREFIXES);
  const none = new Set<string>();

  test("segment 0 returns empty (disabled)", () => {
    expect(getGroupDir("auth_login", 0, defaults)).toBe("");
  });

  test("segment 1 with non-generic prefix", () => {
    expect(getGroupDir("auth_login", 1, defaults)).toBe("auth");
  });

  test("segment 1 skips generic prefix to next segment", () => {
    expect(getGroupDir("get_user_data", 1, defaults)).toBe("user");
  });

  test("segment 1 without skip uses generic prefix as-is", () => {
    expect(getGroupDir("get_user_data", 1, none)).toBe("get");
  });

  test("skips multiple generic prefixes", () => {
    expect(getGroupDir("get_all_users", 1, defaults)).toBe("users");
  });

  test("stops at last segment even if generic", () => {
    expect(getGroupDir("get", 1, defaults)).toBe("get");
  });

  test("single word name returns that word", () => {
    expect(getGroupDir("helpers", 1, defaults)).toBe("helpers");
  });

  test("segment 2 uses second segment", () => {
    expect(getGroupDir("auth_login_check", 2, defaults)).toBe("login");
  });

  test("segment beyond name length returns empty", () => {
    expect(getGroupDir("auth_login", 5, defaults)).toBe("");
  });

  test("common verbs are skipped", () => {
    expect(getGroupDir("insert_order_item", 1, defaults)).toBe("order");
    expect(getGroupDir("delete_session", 1, defaults)).toBe("session");
    expect(getGroupDir("is_admin", 1, defaults)).toBe("admin");
    expect(getGroupDir("compute_value", 1, defaults)).toBe("value");
    expect(getGroupDir("update_user_settings", 1, defaults)).toBe("user");
  });

  test("non-generic first segment is kept", () => {
    expect(getGroupDir("user_settings", 1, defaults)).toBe("user");
    expect(getGroupDir("math_compute", 1, defaults)).toBe("math");
    expect(getGroupDir("order_items", 1, defaults)).toBe("order");
  });

  test("custom skip prefixes", () => {
    const custom = new Set(["auth"]);
    expect(getGroupDir("auth_login", 1, custom)).toBe("login");
    expect(getGroupDir("auth_login", 1, none)).toBe("auth");
  });
});

describe("grants formatting", () => {
  test("formats GRANT/REVOKE statements", () => {
    const sql = `
CREATE FUNCTION mathmodule.myfn(_a int) RETURNS void LANGUAGE sql AS $$ $$;
REVOKE ALL ON FUNCTION mathmodule.myfn(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mathmodule.myfn(int) TO web_user;
`;
    const [parsed] = parseRoutines(sql, { grants: true });
    const result = formatRoutine(parsed);

    expect(result).toContain("revoke all on function mathmodule.myfn(int) from PUBLIC;");
    expect(result).toContain("grant execute on function mathmodule.myfn(int) to web_user;");
  });

  test("formats quoted identifier names correctly", () => {
    const sql = `CREATE FUNCTION _."exists"(text) RETURNS boolean
    LANGUAGE sql
    AS $$ SELECT true; $$;`;
    const [parsed] = parseRoutines(sql);
    const result = formatRoutine(parsed);

    expect(result).toContain('drop function if exists _."exists"(text);');
    expect(result).toContain('create function _."exists"(');
  });

  test("formats quoted schema and name", () => {
    const sql = `CREATE FUNCTION "My Schema"."My Func"() RETURNS void
    LANGUAGE sql AS $$ SELECT 1; $$;`;
    const [parsed] = parseRoutines(sql);
    const result = formatRoutine(parsed);

    expect(result).toContain('drop function if exists "My Schema"."My Func"();');
    expect(result).toContain('create function "My Schema"."My Func"()');
  });

  test("formats COMMENT ON with quoted identifier", () => {
    const sql = `CREATE FUNCTION _."exists"(text) RETURNS boolean
    LANGUAGE sql AS $$ SELECT true; $$;
COMMENT ON FUNCTION _."exists"(text) IS 'Check existence';`;
    const [parsed] = parseRoutines(sql);
    const result = formatRoutine(parsed);

    expect(result).toContain('comment on function _."exists"(text) is \'Check existence\';');
  });

  test("formats GRANT/REVOKE with quoted identifier", () => {
    const sql = `CREATE FUNCTION _."exists"(_a text) RETURNS void LANGUAGE sql AS $$ $$;
GRANT EXECUTE ON FUNCTION _."exists"(text) TO web_user;`;
    const [parsed] = parseRoutines(sql, { grants: true });
    const result = formatRoutine(parsed);

    expect(result).toContain('grant execute on function _."exists"(text) to web_user;');
  });

  test("does not quote unquoted identifiers", () => {
    const sql = `CREATE FUNCTION _.normal_func(text) RETURNS boolean
    LANGUAGE sql AS $$ SELECT true; $$;`;
    const [parsed] = parseRoutines(sql);
    const result = formatRoutine(parsed);

    expect(result).toContain("drop function if exists _.normal_func(text);");
    expect(result).toContain("create function _.normal_func(");
  });
});
