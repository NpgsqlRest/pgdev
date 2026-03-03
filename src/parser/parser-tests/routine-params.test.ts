import { describe, test, expect } from "bun:test";
import { parseRoutines } from "../routine.ts";

describe("parseRoutines — parameters", () => {
  test("no parameters", () => {
    const sql = `CREATE FUNCTION app.get_version() RETURNS text
      LANGUAGE sql AS $$ SELECT '1.0'; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([]);
  });

  test("single named parameter — dir is null when unspecified", () => {
    const sql = `CREATE FUNCTION app.get_user(_id integer) RETURNS void
      LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: null, name: "_id", type: "integer" }]);
  });

  test("multiple named parameters", () => {
    const sql = `CREATE FUNCTION app.create_order(_customer text, _amount numeric, _note text) RETURNS integer
      LANGUAGE plpgsql AS $$ begin return 1; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([
      { dir: null, name: "_customer", type: "text" },
      { dir: null, name: "_amount", type: "numeric" },
      { dir: null, name: "_note", type: "text" },
    ]);
  });

  test("unnamed parameters", () => {
    const sql = `CREATE FUNCTION app.add(integer, integer) RETURNS integer
      LANGUAGE sql AS $$ SELECT $1 + $2; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([
      { dir: null, name: null, type: "integer" },
      { dir: null, name: null, type: "integer" },
    ]);
  });

  test("IN modifier", () => {
    const sql = `CREATE PROCEDURE app.archive(IN _days integer)
      LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: "in", name: "_days", type: "integer" }]);
  });

  test("OUT modifier", () => {
    const sql = `CREATE PROCEDURE app.get_stats(OUT _total integer, OUT _avg numeric)
      LANGUAGE plpgsql AS $$ begin _total := 0; _avg := 0; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([
      { dir: "out", name: "_total", type: "integer" },
      { dir: "out", name: "_avg", type: "numeric" },
    ]);
  });

  test("INOUT modifier", () => {
    const sql = `CREATE PROCEDURE app.increment(INOUT _counter integer)
      LANGUAGE plpgsql AS $$ begin _counter := _counter + 1; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: "inout", name: "_counter", type: "integer" }]);
  });

  test("VARIADIC modifier", () => {
    const sql = `CREATE FUNCTION app.concat_all(VARIADIC _parts text[]) RETURNS text
      LANGUAGE sql AS $$ SELECT array_to_string(_parts, ','); $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: "variadic", name: "_parts", type: "text[]" }]);
  });

  test("mixed IN and OUT modifiers", () => {
    const sql = `CREATE PROCEDURE app.divide(IN _a integer, IN _b integer, OUT _result numeric)
      LANGUAGE plpgsql AS $$ begin _result := _a::numeric / _b; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([
      { dir: "in", name: "_a", type: "integer" },
      { dir: "in", name: "_b", type: "integer" },
      { dir: "out", name: "_result", type: "numeric" },
    ]);
  });

  test("unnamed parameter with IN modifier", () => {
    const sql = `CREATE PROCEDURE app.reset(IN integer)
      LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: "in", name: null, type: "integer" }]);
  });

  test("strips simple DEFAULT value", () => {
    const sql = `CREATE FUNCTION app.list_items(_limit integer DEFAULT 10) RETURNS void
      LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: null, name: "_limit", type: "integer" }]);
  });

  test("strips DEFAULT with cast", () => {
    const sql = `CREATE FUNCTION app.search(_query text DEFAULT NULL::text) RETURNS void
      LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: null, name: "_query", type: "text" }]);
  });

  test("strips DEFAULT with string literal and cast", () => {
    const sql = `CREATE FUNCTION app.greet(_lang text DEFAULT 'en'::text) RETURNS text
      LANGUAGE sql AS $$ SELECT 'hello'; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: null, name: "_lang", type: "text" }]);
  });

  test("strips DEFAULT with jsonb literal", () => {
    const sql = `CREATE FUNCTION app.process(_data jsonb DEFAULT '{}'::jsonb) RETURNS void
      LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: null, name: "_data", type: "jsonb" }]);
  });

  test("strips DEFAULT with parenthesized expression", () => {
    const sql = `CREATE PROCEDURE app.do_thing(IN _flag text DEFAULT (NULL::text = NULL::text))
      LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: "in", name: "_flag", type: "text" }]);
  });

  test("multiple parameters with defaults", () => {
    const sql = `CREATE FUNCTION app.connect(_host text, _port integer DEFAULT 5432, _ssl boolean DEFAULT true) RETURNS void
      LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([
      { dir: null, name: "_host", type: "text" },
      { dir: null, name: "_port", type: "integer" },
      { dir: null, name: "_ssl", type: "boolean" },
    ]);
  });

  test("array types", () => {
    const sql = `CREATE FUNCTION app.sum_all(_values integer[]) RETURNS integer
      LANGUAGE sql AS $$ SELECT 0; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: null, name: "_values", type: "integer[]" }]);
  });

  test("unnamed multi-word type: character varying", () => {
    const sql = `CREATE FUNCTION app.echo(character varying) RETURNS character varying
      LANGUAGE sql AS $$ SELECT $1; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: null, name: null, type: "character varying" }]);
  });

  test("named multi-word type: character varying", () => {
    const sql = `CREATE FUNCTION app.echo(_val character varying) RETURNS character varying
      LANGUAGE sql AS $$ SELECT _val; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: null, name: "_val", type: "character varying" }]);
  });

  test("unnamed multi-word type: double precision", () => {
    const sql = `CREATE FUNCTION app.square(double precision) RETURNS double precision
      LANGUAGE sql AS $$ SELECT $1 * $1; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: null, name: null, type: "double precision" }]);
  });

  test("named multi-word type: timestamp with time zone", () => {
    const sql = `CREATE FUNCTION app.format_ts(_ts timestamp with time zone) RETURNS text
      LANGUAGE sql AS $$ SELECT _ts::text; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: null, name: "_ts", type: "timestamp with time zone" }]);
  });

  test("unnamed multi-word type: timestamp without time zone", () => {
    const sql = `CREATE FUNCTION app.to_epoch(timestamp without time zone) RETURNS bigint
      LANGUAGE sql AS $$ SELECT 0::bigint; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: null, name: null, type: "timestamp without time zone" }]);
  });

  test("numeric with precision", () => {
    const sql = `CREATE FUNCTION app.round_price(_val numeric(10,2)) RETURNS numeric
      LANGUAGE sql AS $$ SELECT _val; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: null, name: "_val", type: "numeric(10,2)" }]);
  });

  test("case insensitive modifiers", () => {
    const sql = `create procedure app.do_it(in _x integer default 0)
      language plpgsql as $$ begin null; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: "in", name: "_x", type: "integer" }]);
  });

  test("RETURNS TABLE does not pollute parameters", () => {
    const sql = `CREATE FUNCTION app.list_users(_active boolean) RETURNS TABLE(id integer, name text)
      LANGUAGE plpgsql AS $$ begin return query select 1, 'a'::text; end; $$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([{ dir: null, name: "_active", type: "boolean" }]);
  });

  test("real pg_dump output with complex defaults", () => {
    const sql = `CREATE FUNCTION inventory.find_products(_category text, _min_price numeric DEFAULT 0, _tags jsonb DEFAULT '{}'::jsonb, _limit integer DEFAULT 100) RETURNS TABLE(id integer, name text, price numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
begin
    return query select p.id, p.name, p.price
    from inventory.products p
    where p.category = _category
      and p.price >= _min_price
    limit _limit;
end;
$$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toEqual([
      { dir: null, name: "_category", type: "text" },
      { dir: null, name: "_min_price", type: "numeric" },
      { dir: null, name: "_tags", type: "jsonb" },
      { dir: null, name: "_limit", type: "integer" },
    ]);
  });

  test("multiple routines each have their own parameters", () => {
    const sql = `CREATE FUNCTION app.add(_a integer, _b integer) RETURNS integer
      LANGUAGE sql AS $$ SELECT _a + _b; $$;

CREATE PROCEDURE app.log_event(IN _msg text)
      LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const results = parseRoutines(sql);
    expect(results[0].parameters).toEqual([
      { dir: null, name: "_a", type: "integer" },
      { dir: null, name: "_b", type: "integer" },
    ]);
    expect(results[1].parameters).toEqual([{ dir: "in", name: "_msg", type: "text" }]);
  });
});
