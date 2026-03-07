import { describe, test, expect } from "bun:test";
import { normalizeType, attributesToCatalog, routinesDiffer } from "../compare.ts";
import { parseRoutines } from "../routine.ts";
import type { CatalogRoutine } from "../catalog.ts";

describe("normalizeType", () => {
  test("int → integer", () => {
    expect(normalizeType("int")).toBe("integer");
  });

  test("int4 → integer", () => {
    expect(normalizeType("int4")).toBe("integer");
  });

  test("int2 → smallint", () => {
    expect(normalizeType("int2")).toBe("smallint");
  });

  test("int8 → bigint", () => {
    expect(normalizeType("int8")).toBe("bigint");
  });

  test("float4 → real", () => {
    expect(normalizeType("float4")).toBe("real");
  });

  test("float8 → double precision", () => {
    expect(normalizeType("float8")).toBe("double precision");
  });

  test("bool → boolean", () => {
    expect(normalizeType("bool")).toBe("boolean");
  });

  test("varchar → character varying", () => {
    expect(normalizeType("varchar")).toBe("character varying");
  });

  test("char → character", () => {
    expect(normalizeType("char")).toBe("character");
  });

  test("timestamptz → timestamp with time zone", () => {
    expect(normalizeType("timestamptz")).toBe("timestamp with time zone");
  });

  test("timetz → time with time zone", () => {
    expect(normalizeType("timetz")).toBe("time with time zone");
  });

  test("serial → integer", () => {
    expect(normalizeType("serial")).toBe("integer");
  });

  test("bigserial → bigint", () => {
    expect(normalizeType("bigserial")).toBe("bigint");
  });

  test("case insensitive", () => {
    expect(normalizeType("INT")).toBe("integer");
    expect(normalizeType("Bool")).toBe("boolean");
    expect(normalizeType("VARCHAR")).toBe("character varying");
  });

  test("already canonical types pass through", () => {
    expect(normalizeType("integer")).toBe("integer");
    expect(normalizeType("text")).toBe("text");
    expect(normalizeType("boolean")).toBe("boolean");
    expect(normalizeType("jsonb")).toBe("jsonb");
    expect(normalizeType("uuid")).toBe("uuid");
  });

  test("trims whitespace", () => {
    expect(normalizeType("  int  ")).toBe("integer");
  });
});

describe("routinesDiffer — type alias normalization", () => {
  function makeCatalog(params: { name: string | null; type: string }[], returnType: string, body = " SELECT 1; "): CatalogRoutine {
    return {
      schema: "public",
      name: "test_fn",
      type: "function",
      parameters: params,
      returns: { setof: false, type: returnType },
      body,
      language: "sql",
      volatility: "volatile",
      strict: false,
      securityDefiner: false,
      parallel: "unsafe",
      leakproof: false,
      cost: 100,
      rows: 0,
      config: [],
      comment: null,
      acl: null,
    };
  }

  test("int param matches integer in catalog", () => {
    const sql = `CREATE FUNCTION public.test_fn(_a int) RETURNS integer LANGUAGE sql AS $$ SELECT 1; $$;`;
    const [parsed] = parseRoutines(sql);
    const catalog = makeCatalog([{ name: "_a", type: "integer" }], "integer");
    expect(routinesDiffer(parsed, catalog)).toBe(false);
  });

  test("varchar param matches character varying in catalog", () => {
    const sql = `CREATE FUNCTION public.test_fn(_a varchar) RETURNS text LANGUAGE sql AS $$ SELECT 'x'; $$;`;
    const [parsed] = parseRoutines(sql);
    const catalog = makeCatalog([{ name: "_a", type: "character varying" }], "text", " SELECT 'x'; ");
    expect(routinesDiffer(parsed, catalog)).toBe(false);
  });

  test("bool param matches boolean in catalog", () => {
    const sql = `CREATE FUNCTION public.test_fn(_a bool) RETURNS bool LANGUAGE sql AS $$ SELECT true; $$;`;
    const [parsed] = parseRoutines(sql);
    const catalog = makeCatalog([{ name: "_a", type: "boolean" }], "boolean", " SELECT true; ");
    expect(routinesDiffer(parsed, catalog)).toBe(false);
  });

  test("timestamptz matches timestamp with time zone", () => {
    const sql = `CREATE FUNCTION public.test_fn(_a timestamptz) RETURNS timestamptz LANGUAGE sql AS $$ SELECT now(); $$;`;
    const [parsed] = parseRoutines(sql);
    const catalog = makeCatalog([{ name: "_a", type: "timestamp with time zone" }], "timestamp with time zone", " SELECT now(); ");
    expect(routinesDiffer(parsed, catalog)).toBe(false);
  });

  test("mixed aliases — int, bool, varchar all match canonical", () => {
    const sql = `CREATE FUNCTION public.test_fn(_a int, _b bool, _c varchar) RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;`;
    const [parsed] = parseRoutines(sql);
    const catalog = makeCatalog([{ name: "_a", type: "integer" }, { name: "_b", type: "boolean" }, { name: "_c", type: "character varying" }], "integer");
    expect(routinesDiffer(parsed, catalog)).toBe(false);
  });

  test("float8 return matches double precision", () => {
    const sql = `CREATE FUNCTION public.test_fn() RETURNS float8 LANGUAGE sql AS $$ SELECT 1.0; $$;`;
    const [parsed] = parseRoutines(sql);
    const catalog = makeCatalog([], "double precision", " SELECT 1.0; ");
    expect(routinesDiffer(parsed, catalog)).toBe(false);
  });

  test("actually different types still detected", () => {
    const sql = `CREATE FUNCTION public.test_fn(_a text) RETURNS integer LANGUAGE sql AS $$ SELECT 1; $$;`;
    const [parsed] = parseRoutines(sql);
    const catalog = makeCatalog([{ name: "_a", type: "integer" }], "integer", " SELECT 1; ");
    expect(routinesDiffer(parsed, catalog)).toBe(true);
  });

  test("RETURNS TABLE matches catalog setof record with rows=1000", () => {
    const sql = `CREATE FUNCTION public.test_fn() RETURNS TABLE(id integer, name text)
      LANGUAGE sql AS $$ SELECT 1, 'a'; $$;`;
    const [parsed] = parseRoutines(sql);
    // Catalog represents RETURNS TABLE as {setof: true, type: "record"}
    const catalog: CatalogRoutine = {
      schema: "public",
      name: "test_fn",
      type: "function",
      parameters: [],
      returns: { setof: true, type: "record" },
      body: " SELECT 1, 'a'; ",
      language: "sql",
      volatility: "volatile",
      strict: false,
      securityDefiner: false,
      parallel: "unsafe",
      leakproof: false,
      cost: 100,
      rows: 1000,
      config: [],
      comment: null,
      acl: null,
    };
    expect(routinesDiffer(parsed, catalog)).toBe(false);
  });

  test("RETURNS TABLE uses setof default for rows attribute", () => {
    const sql = `CREATE FUNCTION public.test_fn() RETURNS TABLE(id integer)
      LANGUAGE sql AS $$ SELECT 1; $$;`;
    const [parsed] = parseRoutines(sql);
    const expected = attributesToCatalog(parsed);
    expect(expected.rows).toBe(1000);
  });

  test("RETURNS SETOF uses setof default for rows attribute", () => {
    const sql = `CREATE FUNCTION public.test_fn() RETURNS SETOF integer
      LANGUAGE sql AS $$ SELECT 1; $$;`;
    const [parsed] = parseRoutines(sql);
    const expected = attributesToCatalog(parsed);
    expect(expected.rows).toBe(1000);
  });

  test("scalar return uses scalar default for rows attribute", () => {
    const sql = `CREATE FUNCTION public.test_fn() RETURNS integer
      LANGUAGE sql AS $$ SELECT 1; $$;`;
    const [parsed] = parseRoutines(sql);
    const expected = attributesToCatalog(parsed);
    expect(expected.rows).toBe(0);
  });

  test("ignoreBodyWhitespace: space around punctuation not detected", () => {
    const sql = `CREATE FUNCTION public.test_fn(_a int) RETURNS integer LANGUAGE sql AS $$ SELECT fn(_a, 1); $$;`;
    const [parsed] = parseRoutines(sql);
    // Catalog body has different spacing around parens/comma
    const catalog = makeCatalog([{ name: "_a", type: "integer" }], "integer", " SELECT fn( _a,1 ); ");
    expect(routinesDiffer(parsed, catalog)).toBe(true); // strict: different
    expect(routinesDiffer(parsed, catalog, { ignoreBodyWhitespace: true })).toBe(false); // ignore: same
  });

  test("ignoreBodyWhitespace: actual code change still detected", () => {
    const sql = `CREATE FUNCTION public.test_fn(_a int) RETURNS integer LANGUAGE sql AS $$ SELECT _a + 1; $$;`;
    const [parsed] = parseRoutines(sql);
    const catalog = makeCatalog([{ name: "_a", type: "integer" }], "integer", " SELECT _a + 2; ");
    expect(routinesDiffer(parsed, catalog, { ignoreBodyWhitespace: true })).toBe(true);
  });
});
