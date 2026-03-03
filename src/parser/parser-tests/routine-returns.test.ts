import { describe, test, expect } from "bun:test";
import { parseRoutines } from "../routine.ts";

describe("parseRoutines — return type", () => {
  // Simple types

  test("RETURNS void", () => {
    const sql = `CREATE FUNCTION app.noop() RETURNS void
      LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({ setof: false, type: "void", table: null });
  });

  test("RETURNS integer", () => {
    const sql = `CREATE FUNCTION app.count_items() RETURNS integer
      LANGUAGE sql AS $$ SELECT 42; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({ setof: false, type: "integer", table: null });
  });

  test("RETURNS text", () => {
    const sql = `CREATE FUNCTION app.greet() RETURNS text
      LANGUAGE sql AS $$ SELECT 'hi'; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({ setof: false, type: "text", table: null });
  });

  test("RETURNS boolean", () => {
    const sql = `CREATE FUNCTION app.is_valid() RETURNS boolean
      LANGUAGE sql AS $$ SELECT true; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({ setof: false, type: "boolean", table: null });
  });

  // Array return type

  test("RETURNS integer[]", () => {
    const sql = `CREATE FUNCTION app.get_ids() RETURNS integer[]
      LANGUAGE sql AS $$ SELECT ARRAY[1,2,3]; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({ setof: false, type: "integer[]", table: null });
  });

  // Multi-word return types

  test("RETURNS character varying", () => {
    const sql = `CREATE FUNCTION app.get_label() RETURNS character varying
      LANGUAGE sql AS $$ SELECT 'x'::character varying; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({ setof: false, type: "character varying", table: null });
  });

  test("RETURNS double precision", () => {
    const sql = `CREATE FUNCTION app.get_ratio() RETURNS double precision
      LANGUAGE sql AS $$ SELECT 3.14; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({ setof: false, type: "double precision", table: null });
  });

  test("RETURNS timestamp with time zone", () => {
    const sql = `CREATE FUNCTION app.now_utc() RETURNS timestamp with time zone
      LANGUAGE sql AS $$ SELECT now(); $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({ setof: false, type: "timestamp with time zone", table: null });
  });

  // SETOF

  test("RETURNS SETOF integer", () => {
    const sql = `CREATE FUNCTION app.all_ids() RETURNS SETOF integer
      LANGUAGE sql AS $$ SELECT id FROM app.items; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({ setof: true, type: "integer", table: null });
  });

  test("RETURNS SETOF text", () => {
    const sql = `CREATE FUNCTION app.all_names() RETURNS SETOF text
      LANGUAGE sql AS $$ SELECT name FROM app.items; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({ setof: true, type: "text", table: null });
  });

  test("RETURNS SETOF record", () => {
    const sql = `CREATE FUNCTION app.get_rows() RETURNS SETOF record
      LANGUAGE sql AS $$ SELECT * FROM app.items; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({ setof: true, type: "record", table: null });
  });

  // TABLE

  test("RETURNS TABLE with single column", () => {
    const sql = `CREATE FUNCTION app.get_ids() RETURNS TABLE(id integer)
      LANGUAGE sql AS $$ SELECT id FROM app.items; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({
      setof: false,
      type: null,
      table: [{ name: "id", type: "integer" }],
    });
  });

  test("RETURNS TABLE with multiple columns", () => {
    const sql = `CREATE FUNCTION app.list_users() RETURNS TABLE(id integer, name text, active boolean)
      LANGUAGE sql AS $$ SELECT id, name, active FROM app.users; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({
      setof: false,
      type: null,
      table: [
        { name: "id", type: "integer" },
        { name: "name", type: "text" },
        { name: "active", type: "boolean" },
      ],
    });
  });

  test("RETURNS TABLE with array column type", () => {
    const sql = `CREATE FUNCTION app.get_tags() RETURNS TABLE(id integer, tags text[])
      LANGUAGE sql AS $$ SELECT 1, ARRAY['a']; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({
      setof: false,
      type: null,
      table: [
        { name: "id", type: "integer" },
        { name: "tags", type: "text[]" },
      ],
    });
  });

  test("RETURNS TABLE with multi-word column type", () => {
    const sql = `CREATE FUNCTION app.get_ts() RETURNS TABLE(created timestamp with time zone, label character varying)
      LANGUAGE sql AS $$ SELECT now(), 'x'::character varying; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({
      setof: false,
      type: null,
      table: [
        { name: "created", type: "timestamp with time zone" },
        { name: "label", type: "character varying" },
      ],
    });
  });

  // Procedure — no RETURNS

  test("procedure has null returns", () => {
    const sql = `CREATE PROCEDURE app.cleanup(IN _days integer)
      LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toBeNull();
  });

  // Case insensitivity

  test("case insensitive RETURNS", () => {
    const sql = `create function app.lower() returns text
      language sql as $$ select 'hi'; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({ setof: false, type: "text", table: null });
  });

  test("case insensitive SETOF", () => {
    const sql = `CREATE FUNCTION app.rows() RETURNS setof text
      LANGUAGE sql AS $$ SELECT 'a'; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({ setof: true, type: "text", table: null });
  });

  // Real pg_dump output

  test("real pg_dump RETURNS TABLE with many columns", () => {
    const sql = `CREATE FUNCTION inventory.find_products(_category text, _min_price numeric DEFAULT 0) RETURNS TABLE(id integer, name text, price numeric, in_stock boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
begin
    return query select p.id, p.name, p.price, p.in_stock
    from inventory.products p
    where p.category = _category and p.price >= _min_price;
end;
$$;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({
      setof: false,
      type: null,
      table: [
        { name: "id", type: "integer" },
        { name: "name", type: "text" },
        { name: "price", type: "numeric" },
        { name: "in_stock", type: "boolean" },
      ],
    });
  });

  // BEGIN ATOMIC function

  test("RETURNS with BEGIN ATOMIC function", () => {
    const sql = `CREATE FUNCTION app.add(int, int) RETURNS int
      IMMUTABLE PARALLEL SAFE
      BEGIN ATOMIC;
        SELECT $1 + $2;
      END;`;
    const [r] = parseRoutines(sql);
    expect(r.returns).toEqual({ setof: false, type: "int", table: null });
  });

  // Multiple routines

  test("each routine gets its own return type", () => {
    const sql = `CREATE FUNCTION app.get_count() RETURNS integer
      LANGUAGE sql AS $$ SELECT 1; $$;

CREATE FUNCTION app.get_names() RETURNS SETOF text
      LANGUAGE sql AS $$ SELECT 'a'; $$;

CREATE PROCEDURE app.do_stuff()
      LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const results = parseRoutines(sql);
    expect(results[0].returns).toEqual({ setof: false, type: "integer", table: null });
    expect(results[1].returns).toEqual({ setof: true, type: "text", table: null });
    expect(results[2].returns).toBeNull();
  });
});
