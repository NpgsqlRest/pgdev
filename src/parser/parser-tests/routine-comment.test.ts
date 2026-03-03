import { describe, test, expect } from "bun:test";
import { parseRoutines } from "../routine.ts";

describe("parseRoutines — comment extraction", () => {
  test("extracts COMMENT ON FUNCTION", () => {
    const sql = `
CREATE FUNCTION app.greet(_name text) RETURNS text
  LANGUAGE sql AS $$ SELECT 'hello ' || _name; $$;

COMMENT ON FUNCTION app.greet(text) IS 'Say hello';
`;
    const [r] = parseRoutines(sql);
    expect(r.comment).toBe("Say hello");
  });

  test("extracts COMMENT ON PROCEDURE", () => {
    const sql = `
CREATE PROCEDURE app.cleanup()
  LANGUAGE sql AS $$ SELECT 1; $$;

COMMENT ON PROCEDURE app.cleanup() IS 'Clean up stale data';
`;
    const [r] = parseRoutines(sql);
    expect(r.comment).toBe("Clean up stale data");
  });

  test("comment is null when no COMMENT ON present", () => {
    const sql = `
CREATE FUNCTION app.greet(_name text) RETURNS text
  LANGUAGE sql AS $$ SELECT 'hello ' || _name; $$;
`;
    const [r] = parseRoutines(sql);
    expect(r.comment).toBeNull();
  });

  test("matches comment by parameter type (ignores name)", () => {
    const sql = `
CREATE FUNCTION app.add(a integer, b integer) RETURNS integer
  LANGUAGE sql AS $$ SELECT a + b; $$;

COMMENT ON FUNCTION app.add(integer, integer) IS 'Add two numbers';
`;
    const [r] = parseRoutines(sql);
    expect(r.comment).toBe("Add two numbers");
  });

  test("handles escaped single quotes in comment", () => {
    const sql = `
CREATE FUNCTION app.greet() RETURNS text
  LANGUAGE sql AS $$ SELECT 'hi'; $$;

COMMENT ON FUNCTION app.greet() IS 'It''s a greeting';
`;
    const [r] = parseRoutines(sql);
    expect(r.comment).toBe("It's a greeting");
  });

  test("each routine gets its own comment", () => {
    const sql = `
CREATE FUNCTION app.one() RETURNS int
  LANGUAGE sql AS $$ SELECT 1; $$;

COMMENT ON FUNCTION app.one() IS 'Returns one';

CREATE FUNCTION app.two() RETURNS int
  LANGUAGE sql AS $$ SELECT 2; $$;

COMMENT ON FUNCTION app.two() IS 'Returns two';
`;
    const results = parseRoutines(sql);
    expect(results[0].comment).toBe("Returns one");
    expect(results[1].comment).toBe("Returns two");
  });

  test("routine without comment is null when sibling has comment", () => {
    const sql = `
CREATE FUNCTION app.one() RETURNS int
  LANGUAGE sql AS $$ SELECT 1; $$;

CREATE FUNCTION app.two() RETURNS int
  LANGUAGE sql AS $$ SELECT 2; $$;

COMMENT ON FUNCTION app.two() IS 'Returns two';
`;
    const results = parseRoutines(sql);
    expect(results[0].comment).toBeNull();
    expect(results[1].comment).toBe("Returns two");
  });

  test("handles pg_dump style output", () => {
    const sql = `
CREATE FUNCTION inventory.get_product(_id integer) RETURNS TABLE(name text, price numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
begin
    return query select p.name, p.price from inventory.products p where p.id = _id;
end;
$$;

COMMENT ON FUNCTION inventory.get_product(_id integer) IS 'HTTP GET';
`;
    const [r] = parseRoutines(sql);
    expect(r.comment).toBe("HTTP GET");
  });

  test("case-insensitive COMMENT ON matching", () => {
    const sql = `
CREATE FUNCTION app.greet() RETURNS text
  LANGUAGE sql AS $$ SELECT 'hi'; $$;

comment on function app.greet() is 'Hello';
`;
    const [r] = parseRoutines(sql);
    expect(r.comment).toBe("Hello");
  });

  test("comment without schema matches routine without schema", () => {
    const sql = `
CREATE FUNCTION greet() RETURNS text
  LANGUAGE sql AS $$ SELECT 'hi'; $$;

COMMENT ON FUNCTION greet() IS 'Hello';
`;
    const [r] = parseRoutines(sql);
    expect(r.comment).toBe("Hello");
  });
});
