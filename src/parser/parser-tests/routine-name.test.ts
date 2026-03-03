import { describe, test, expect } from "bun:test";
import { parseRoutines } from "../routine.ts";

describe("parseRoutines", () => {
  test("returns empty array for empty string", () => {
    expect(parseRoutines("")).toEqual([]);
  });

  test("returns empty array for non-SQL content", () => {
    expect(parseRoutines("hello world\nthis is not sql")).toEqual([]);
  });

  test("returns empty array for SQL without routines", () => {
    expect(parseRoutines("CREATE TABLE foo (id int);")).toEqual([]);
  });

  test("parses CREATE FUNCTION with schema-qualified name", () => {
    const sql = `CREATE FUNCTION inventory.get_product(_product_id integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  null;
end;
$$;`;
    const result = parseRoutines(sql);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("get_product");
  });

  test("parses CREATE PROCEDURE with schema-qualified name", () => {
    const sql = `CREATE PROCEDURE inventory.restock_item(IN _item_id integer, IN _quantity integer)
    LANGUAGE plpgsql
    AS $$
begin
  null;
end;
$$;`;
    const result = parseRoutines(sql);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("restock_item");
  });

  test("parses CREATE OR REPLACE FUNCTION", () => {
    const sql = `CREATE OR REPLACE FUNCTION billing.calculate_total(x int) RETURNS int
    LANGUAGE sql
    AS $$ SELECT x + 1; $$;`;
    const result = parseRoutines(sql);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("calculate_total");
  });

  test("parses CREATE OR REPLACE PROCEDURE", () => {
    const sql = `CREATE OR REPLACE PROCEDURE billing.archive_invoices(IN days int)
    LANGUAGE plpgsql
    AS $$
begin
  delete from invoices where created < now() - (days || ' days')::interval;
end;
$$;`;
    const result = parseRoutines(sql);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("archive_invoices");
  });

  test("parses unqualified function name (no schema)", () => {
    const sql = `CREATE FUNCTION my_func() RETURNS void
    LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const result = parseRoutines(sql);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("my_func");
  });

  test("parses multiple routines in one file", () => {
    const sql = `CREATE FUNCTION inventory.format_price(_amount numeric, _currency text) RETURNS text
    LANGUAGE sql STABLE AS $$ SELECT _currency || _amount::text; $$;

CREATE FUNCTION inventory.format_price(_amount numeric, _currency text, _show_cents boolean) RETURNS text
    LANGUAGE plpgsql AS $$
begin
  return _currency || _amount::text;
end;
$$;`;
    const result = parseRoutines(sql);
    expect(result.length).toBe(2);
    expect(result[0].name).toBe("format_price");
    expect(result[1].name).toBe("format_price");
  });

  test("ignores CREATE FUNCTION inside SQL block comments", () => {
    const sql = `/*
CREATE FUNCTION fake.should_be_ignored() RETURNS void
    LANGUAGE plpgsql AS $$ begin null; end; $$;
*/
CREATE FUNCTION catalog.real_func() RETURNS void
    LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const result = parseRoutines(sql);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("real_func");
  });

  test("ignores CREATE FUNCTION inside single-line comments", () => {
    const sql = `-- CREATE FUNCTION fake.ignored() RETURNS void
CREATE FUNCTION catalog.actual() RETURNS void
    LANGUAGE plpgsql AS $$ begin null; end; $$;`;
    const result = parseRoutines(sql);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("actual");
  });

  test("ignores CREATE FUNCTION inside dollar-quoted body", () => {
    const sql = `CREATE FUNCTION tools.outer_func() RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  -- This should not be parsed as a routine:
  execute 'CREATE FUNCTION tools.inner_dynamic() RETURNS void LANGUAGE sql AS $inner$ SELECT 1; $inner$';
end;
$$;`;
    const result = parseRoutines(sql);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("outer_func");
  });

  test("case insensitive matching", () => {
    const sql = `create function billing.lower_case() returns void
    language plpgsql as $$ begin null; end; $$;`;
    const result = parseRoutines(sql);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("lower_case");
  });

  test("handles real pg_dump output with headers and comments", () => {
    const sql = `--
-- PostgreSQL database dump
--

-- Dumped from database version 16.10 (Ubuntu 16.10-1.pgdg22.04+1)
-- Dumped by pg_dump version 18.1

--
-- Name: get_product(integer); Type: FUNCTION; Schema: inventory; Owner: shopdb
--

CREATE FUNCTION inventory.get_product(_product_id integer) RETURNS TABLE(id integer, name text, price numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
begin
    return query select p.id, p.name, p.price from inventory.products p where p.id = _product_id;
end;
$$;

--
-- Name: FUNCTION get_product(...); Type: COMMENT; Schema: inventory; Owner: shopdb
--

COMMENT ON FUNCTION inventory.get_product(_product_id integer) IS 'HTTP GET
product
anonymous';

--
-- PostgreSQL database dump complete
--
`;
    const result = parseRoutines(sql);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("get_product");
  });

  test("returns type field: function or procedure", () => {
    const sql = `CREATE FUNCTION s.my_func() RETURNS void LANGUAGE sql AS $$ SELECT 1; $$;
CREATE PROCEDURE s.my_proc() LANGUAGE sql AS $$ SELECT 1; $$;`;
    const result = parseRoutines(sql);
    expect(result.length).toBe(2);
    expect(result[0].type).toBe("function");
    expect(result[1].type).toBe("procedure");
  });

  test("returns schema field", () => {
    const sql = `CREATE FUNCTION inventory.my_func() RETURNS void LANGUAGE sql AS $$ SELECT 1; $$;`;
    const result = parseRoutines(sql);
    expect(result[0].schema).toBe("inventory");
  });

  test("schema is null for unqualified names", () => {
    const sql = `CREATE FUNCTION my_func() RETURNS void LANGUAGE sql AS $$ SELECT 1; $$;`;
    const result = parseRoutines(sql);
    expect(result[0].schema).toBeNull();
  });

  test("handles nested block comments", () => {
    const sql = `/* outer /* inner CREATE FUNCTION fake.f() RETURNS void */ still comment */
CREATE FUNCTION catalog.func() RETURNS void LANGUAGE sql AS $$ SELECT 1; $$;`;
    const result = parseRoutines(sql);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("func");
  });
});
