import { describe, test, expect } from "bun:test";
import { parseRoutines } from "../routine.ts";

describe("parseRoutines — attributes", () => {
  test("extracts LANGUAGE", () => {
    const sql = `CREATE FUNCTION app.greet() RETURNS text
      LANGUAGE plpgsql AS $$ begin return 'hi'; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("LANGUAGE plpgsql");
  });

  test("extracts LANGUAGE sql", () => {
    const sql = `CREATE FUNCTION app.one() RETURNS integer
      LANGUAGE sql AS $$ SELECT 1; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("LANGUAGE sql");
  });

  test("extracts SECURITY DEFINER", () => {
    const sql = `CREATE FUNCTION app.secret() RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER
      AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("LANGUAGE plpgsql");
    expect(r.attributes).toContain("SECURITY DEFINER");
  });

  test("extracts SECURITY INVOKER", () => {
    const sql = `CREATE FUNCTION app.public_fn() RETURNS void
      LANGUAGE plpgsql SECURITY INVOKER
      AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("SECURITY INVOKER");
  });

  test("extracts EXTERNAL SECURITY DEFINER", () => {
    const sql = `CREATE FUNCTION app.ext() RETURNS void
      LANGUAGE plpgsql EXTERNAL SECURITY DEFINER
      AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("EXTERNAL SECURITY DEFINER");
  });

  test("extracts IMMUTABLE", () => {
    const sql = `CREATE FUNCTION app.pure(_x int) RETURNS int
      LANGUAGE sql IMMUTABLE AS $$ SELECT _x + 1; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("IMMUTABLE");
  });

  test("extracts STABLE", () => {
    const sql = `CREATE FUNCTION app.now_text() RETURNS text
      LANGUAGE sql STABLE AS $$ SELECT now()::text; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("STABLE");
  });

  test("extracts VOLATILE", () => {
    const sql = `CREATE FUNCTION app.rand() RETURNS double precision
      LANGUAGE sql VOLATILE AS $$ SELECT random(); $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("VOLATILE");
  });

  test("extracts PARALLEL SAFE", () => {
    const sql = `CREATE FUNCTION app.add(_a int, _b int) RETURNS int
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT _a + _b; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("PARALLEL SAFE");
  });

  test("extracts PARALLEL RESTRICTED", () => {
    const sql = `CREATE FUNCTION app.lookup() RETURNS text
      LANGUAGE sql STABLE PARALLEL RESTRICTED AS $$ SELECT 'x'; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("PARALLEL RESTRICTED");
  });

  test("extracts PARALLEL UNSAFE", () => {
    const sql = `CREATE FUNCTION app.mutate() RETURNS void
      LANGUAGE plpgsql PARALLEL UNSAFE AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("PARALLEL UNSAFE");
  });

  test("extracts STRICT", () => {
    const sql = `CREATE FUNCTION app.safe_div(_a int, _b int) RETURNS int
      LANGUAGE sql STRICT AS $$ SELECT _a / _b; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("STRICT");
  });

  test("extracts CALLED ON NULL INPUT", () => {
    const sql = `CREATE FUNCTION app.coalesce_int(_x int) RETURNS int
      LANGUAGE sql CALLED ON NULL INPUT AS $$ SELECT coalesce(_x, 0); $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("CALLED ON NULL INPUT");
  });

  test("extracts RETURNS NULL ON NULL INPUT", () => {
    const sql = `CREATE FUNCTION app.double(_x int) RETURNS int
      LANGUAGE sql RETURNS NULL ON NULL INPUT AS $$ SELECT _x * 2; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("RETURNS NULL ON NULL INPUT");
  });

  test("extracts LEAKPROOF", () => {
    const sql = `CREATE FUNCTION app.cmp(_a text, _b text) RETURNS boolean
      LANGUAGE sql IMMUTABLE LEAKPROOF AS $$ SELECT _a = _b; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("LEAKPROOF");
  });

  test("extracts NOT LEAKPROOF", () => {
    const sql = `CREATE FUNCTION app.cmp(_a text, _b text) RETURNS boolean
      LANGUAGE sql NOT LEAKPROOF AS $$ SELECT _a = _b; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("NOT LEAKPROOF");
  });

  test("extracts COST", () => {
    const sql = `CREATE FUNCTION app.heavy() RETURNS void
      LANGUAGE plpgsql COST 1000 AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("COST 1000");
  });

  test("extracts ROWS", () => {
    const sql = `CREATE FUNCTION app.generate() RETURNS SETOF integer
      LANGUAGE sql ROWS 500 AS $$ SELECT generate_series(1, 500); $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("ROWS 500");
  });

  test("extracts WINDOW", () => {
    const sql = `CREATE FUNCTION app.my_agg(internal) RETURNS internal
      LANGUAGE c WINDOW AS 'my_lib', 'my_agg';`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("WINDOW");
  });

  test("extracts SET parameter with =", () => {
    const sql = `CREATE FUNCTION app.secure() RETURNS void
      LANGUAGE plpgsql SET search_path = 'public'
      AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("SET search_path = 'public'");
  });

  test("extracts SET parameter with TO", () => {
    const sql = `CREATE FUNCTION app.slow() RETURNS void
      LANGUAGE plpgsql SET work_mem TO '64MB'
      AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("SET work_mem TO '64MB'");
  });

  test("extracts SET parameter FROM CURRENT", () => {
    const sql = `CREATE FUNCTION app.inherit() RETURNS void
      LANGUAGE plpgsql SET search_path FROM CURRENT
      AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("SET search_path FROM CURRENT");
  });

  test("extracts SUPPORT", () => {
    const sql = `CREATE FUNCTION app.my_fn() RETURNS void
      LANGUAGE sql SUPPORT app.my_support AS $$ SELECT 1; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("SUPPORT app.my_support");
  });

  test("extracts TRANSFORM FOR TYPE", () => {
    const sql = `CREATE FUNCTION app.transform_fn(_j jsonb) RETURNS text
      LANGUAGE plpython3u TRANSFORM FOR TYPE jsonb
      AS $$ return str(j) $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toContain("TRANSFORM FOR TYPE jsonb");
  });

  // Multiple attributes combined

  test("extracts multiple attributes from pg_dump output", () => {
    const sql = `CREATE FUNCTION inventory.find_products(_category text) RETURNS TABLE(id integer, name text)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
begin
    return query select 1, 'x'::text;
end;
$$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toEqual(["LANGUAGE plpgsql", "SECURITY DEFINER"]);
  });

  test("extracts many attributes in order", () => {
    const sql = `CREATE FUNCTION app.compute(_x double precision) RETURNS double precision
      LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT LEAKPROOF COST 10
      AS $$ SELECT _x * 2; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toEqual([
      "LANGUAGE sql",
      "IMMUTABLE",
      "PARALLEL SAFE",
      "STRICT",
      "LEAKPROOF",
      "COST 10",
    ]);
  });

  // Does not include RETURNS in attributes

  test("RETURNS type is not in attributes", () => {
    const sql = `CREATE FUNCTION app.one() RETURNS integer
      LANGUAGE sql AS $$ SELECT 1; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toEqual(["LANGUAGE sql"]);
  });

  test("RETURNS TABLE is not in attributes", () => {
    const sql = `CREATE FUNCTION app.list() RETURNS TABLE(id integer, name text)
      LANGUAGE sql AS $$ SELECT 1, 'a'::text; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toEqual(["LANGUAGE sql"]);
  });

  test("RETURNS SETOF is not in attributes", () => {
    const sql = `CREATE FUNCTION app.ids() RETURNS SETOF integer
      LANGUAGE sql AS $$ SELECT 1; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toEqual(["LANGUAGE sql"]);
  });

  // Procedure

  test("procedure attributes (no RETURNS to exclude)", () => {
    const sql = `CREATE PROCEDURE app.cleanup(IN _days integer)
      LANGUAGE plpgsql SECURITY DEFINER
      AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toEqual(["LANGUAGE plpgsql", "SECURITY DEFINER"]);
  });

  // BEGIN ATOMIC

  test("attributes with BEGIN ATOMIC body", () => {
    const sql = `CREATE FUNCTION app.add(int, int) RETURNS int
      IMMUTABLE PARALLEL SAFE
      BEGIN ATOMIC;
        SELECT $1 + $2;
      END;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toEqual(["IMMUTABLE", "PARALLEL SAFE"]);
  });

  // Case insensitivity

  test("case insensitive attributes", () => {
    const sql = `create function app.lower() returns void
      language plpgsql security definer
      as $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toEqual(["language plpgsql", "security definer"]);
  });

  // Empty attributes (C function with no body)

  test("function with only LANGUAGE and no body", () => {
    const sql = `CREATE FUNCTION app.c_fn(integer) RETURNS void
      LANGUAGE c;`;
    const [r] = parseRoutines(sql);
    expect(r.attributes).toEqual(["LANGUAGE c"]);
  });

  // Multiple routines

  test("each routine gets its own attributes", () => {
    const sql = `CREATE FUNCTION app.pure(_x int) RETURNS int
      LANGUAGE sql IMMUTABLE AS $$ SELECT _x; $$;

CREATE FUNCTION app.volatile_fn() RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER
      AS $$ begin null; end; $$;`;
    const results = parseRoutines(sql);
    expect(results[0].attributes).toEqual(["LANGUAGE sql", "IMMUTABLE"]);
    expect(results[1].attributes).toEqual(["LANGUAGE plpgsql", "SECURITY DEFINER"]);
  });
});
