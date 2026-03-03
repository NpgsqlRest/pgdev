import { describe, test, expect } from "bun:test";
import { parseRoutines } from "../routine.ts";

describe("parseRoutines — body extraction", () => {
  // Dollar-quoted bodies

  test("extracts dollar-quoted body with $$", () => {
    const sql = `CREATE FUNCTION app.greet() RETURNS text
      LANGUAGE sql AS $$SELECT 'hello';$$;`;
    const [r] = parseRoutines(sql);
    expect(r.body).toBe("SELECT 'hello';");
  });

  test("extracts dollar-quoted body with $$ and whitespace", () => {
    const sql = `CREATE FUNCTION app.greet() RETURNS text
      LANGUAGE sql
      AS $$
SELECT 'hello';
$$;`;
    const [r] = parseRoutines(sql);
    expect(r.body).toBe("\nSELECT 'hello';\n");
  });

  test("extracts dollar-quoted body with custom tag", () => {
    const sql = `CREATE FUNCTION app.greet() RETURNS text
      LANGUAGE sql AS $fn$SELECT 1;$fn$;`;
    const [r] = parseRoutines(sql);
    expect(r.body).toBe("SELECT 1;");
  });

  test("preserves nested dollar quotes in body", () => {
    const sql = `CREATE FUNCTION app.check_pattern() RETURNS boolean
      LANGUAGE plpgsql AS $function$
BEGIN
    RETURN ($1 ~ $q$[\\t\\r\\n]$q$);
END;
$function$;`;
    const [r] = parseRoutines(sql);
    expect(r.body).toContain("$q$[\\t\\r\\n]$q$");
  });

  test("extracts multiline plpgsql body", () => {
    const sql = `CREATE FUNCTION app.do_stuff(_x integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare
    _val integer;
begin
    _val := _x + 1;
    raise notice 'result: %', _val;
end;
$$;`;
    const [r] = parseRoutines(sql);
    expect(r.body).toContain("declare");
    expect(r.body).toContain("_val := _x + 1;");
    expect(r.body).toContain("raise notice");
  });

  // Single-quoted bodies

  test("extracts single-quoted body", () => {
    const sql = `CREATE FUNCTION app.add(integer, integer) RETURNS integer
      LANGUAGE sql AS 'SELECT $1 + $2';`;
    const [r] = parseRoutines(sql);
    expect(r.body).toBe("SELECT $1 + $2");
  });

  test("extracts single-quoted body with escaped quotes", () => {
    const sql = `CREATE FUNCTION app.quote_name(_name text) RETURNS text
      LANGUAGE sql AS 'SELECT ''\"'' || _name || ''\"''';`;
    const [r] = parseRoutines(sql);
    expect(r.body).toBe(`SELECT '"' || _name || '"'`);
  });

  test("extracts E-prefixed escape string body", () => {
    const sql = `CREATE FUNCTION app.newline() RETURNS text
      LANGUAGE sql AS E'SELECT E''line1\\nline2''';`;
    const [r] = parseRoutines(sql);
    expect(r.body).toBe("SELECT E'line1\\nline2'");
  });

  // BEGIN ATOMIC (SQL-standard)

  test("extracts BEGIN ATOMIC body", () => {
    const sql = `CREATE FUNCTION app.add(int, int) RETURNS int
      IMMUTABLE PARALLEL SAFE
      BEGIN ATOMIC;
        SELECT $1 + $2;
      END;`;
    const [r] = parseRoutines(sql);
    expect(r.body).toContain("SELECT $1 + $2;");
  });

  test("extracts BEGIN ATOMIC body with multiple statements", () => {
    const sql = `CREATE FUNCTION app.process(_x int) RETURNS int
      BEGIN ATOMIC;
        INSERT INTO app.log VALUES (_x);
        SELECT _x * 2;
      END;`;
    const [r] = parseRoutines(sql);
    expect(r.body).toContain("INSERT INTO app.log VALUES (_x);");
    expect(r.body).toContain("SELECT _x * 2;");
  });

  // Edge cases

  test("body is null when no body found", () => {
    const sql = `CREATE FUNCTION app.ext_func(integer) RETURNS void
      LANGUAGE c;`;
    const [r] = parseRoutines(sql);
    expect(r.body).toBeNull();
  });

  test("multiple routines each get their own body", () => {
    const sql = `CREATE FUNCTION app.one() RETURNS int
      LANGUAGE sql AS $$SELECT 1;$$;

CREATE FUNCTION app.two() RETURNS int
      LANGUAGE sql AS $$SELECT 2;$$;`;
    const results = parseRoutines(sql);
    expect(results[0].body).toBe("SELECT 1;");
    expect(results[1].body).toBe("SELECT 2;");
  });

  test("handles real pg_dump output", () => {
    const sql = `--
-- PostgreSQL database dump
--

CREATE FUNCTION inventory.get_product(_id integer) RETURNS TABLE(name text, price numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
begin
    return query select p.name, p.price from inventory.products p where p.id = _id;
end;
$$;

COMMENT ON FUNCTION inventory.get_product(_id integer) IS 'HTTP GET';

--
-- PostgreSQL database dump complete
--
`;
    const [r] = parseRoutines(sql);
    expect(r.body).toContain("return query select");
    expect(r.body).not.toContain("COMMENT ON");
  });
});
