import { describe, test, expect } from "bun:test";
import { parsePgdevHeader, stripPgdevHeader } from "../header.ts";

describe("parsePgdevHeader", () => {
  describe("returns null for no header", () => {
    test("empty string", () => {
      expect(parsePgdevHeader("")).toBeNull();
    });

    test("plain SQL with no header", () => {
      expect(parsePgdevHeader("CREATE FUNCTION foo() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;")).toBeNull();
    });

    test("regular SQL comment without pgdev", () => {
      expect(parsePgdevHeader("-- This is a regular comment\nCREATE FUNCTION foo() RETURNS void;")).toBeNull();
    });

    test("block comment without pgdev section", () => {
      expect(parsePgdevHeader("/*\nregular comment\n*/\nCREATE FUNCTION foo();")).toBeNull();
    });

    test("block comment with --- but no [pgdev]", () => {
      expect(parsePgdevHeader("/*\n---\nsome = \"toml\"\n---\n*/\nSELECT 1;")).toBeNull();
    });
  });

  describe("Format 1 — line comments", () => {
    test("basic type", () => {
      const content = `-- [pgdev]
-- type = "routine"
CREATE FUNCTION foo();`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("routine");
    });

    test("repeatable type", () => {
      const content = `-- [pgdev]
-- type = "repeatable"
SELECT 1;`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("repeatable");
    });

    test("versioned with version", () => {
      const content = `-- [pgdev]
-- version = "001"
CREATE TABLE foo();`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.version).toBe("001");
    });

    test("type + version", () => {
      const content = `-- [pgdev]
-- type = "versioned"
-- version = "002"
CREATE TABLE foo();`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("versioned");
      expect(header!.version).toBe("002");
    });

    test("run_before", () => {
      const content = `-- [pgdev]
-- type = "routine"
-- run_before = "R__create_views"
CREATE FUNCTION foo();`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.run_before).toBe("R__create_views");
    });

    test("rerun_with as string", () => {
      const content = `-- [pgdev]
-- type = "routine"
-- rerun_with = "R__extensions"
CREATE FUNCTION foo();`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.rerun_with).toEqual(["R__extensions"]);
    });

    test("rerun_with as array", () => {
      const content = `-- [pgdev]
-- type = "routine"
-- rerun_with = ["R__extensions", "V001__schema"]
CREATE FUNCTION foo();`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.rerun_with).toEqual(["R__extensions", "V001__schema"]);
    });

    test("all fields", () => {
      const content = `-- [pgdev]
-- type = "routine"
-- run_before = "R__views"
-- rerun_with = ["R__types", "R__extensions"]
CREATE FUNCTION foo();`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("routine");
      expect(header!.run_before).toBe("R__views");
      expect(header!.rerun_with).toEqual(["R__types", "R__extensions"]);
    });

    test("stops at non-comment line", () => {
      const content = `-- [pgdev]
-- type = "routine"
CREATE FUNCTION foo();
-- run_before = "should_not_be_parsed"`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("routine");
      expect(header!.run_before).toBeUndefined();
    });

    test("with TOML comments", () => {
      const content = `-- [pgdev]
-- # This is a TOML comment
-- type = "repeatable"
SELECT 1;`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("repeatable");
    });

    test("extra spaces around [pgdev]", () => {
      const content = `--   [pgdev]
-- type = "routine"
SELECT 1;`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("routine");
    });
  });

  describe("Format 2 — block comment with --- delimiters", () => {
    test("basic type", () => {
      const content = `/*
---
[pgdev]
type = "routine"
---
*/
CREATE FUNCTION foo();`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("routine");
    });

    test("with regular comment before ---", () => {
      const content = `/*
This is a regular comment about the file.
It can span multiple lines.
---
[pgdev]
type = "repeatable"
---
*/
SELECT 1;`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("repeatable");
    });

    test("versioned with version", () => {
      const content = `/*
---
[pgdev]
type = "versioned"
version = "000"
---
*/
CREATE TABLE foo();`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("versioned");
      expect(header!.version).toBe("000");
    });

    test("all fields", () => {
      const content = `/*
---
[pgdev]
type = "routine"
run_before = "R__views"
rerun_with = ["R__types"]
---
*/
CREATE FUNCTION foo();`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("routine");
      expect(header!.run_before).toBe("R__views");
      expect(header!.rerun_with).toEqual(["R__types"]);
    });

    test("with TOML comments inside", () => {
      const content = `/*
---
[pgdev]
# Migration type
type = "routine"
# Version number
# version = ""
---
*/
SELECT 1;`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("routine");
      expect(header!.version).toBeUndefined();
    });

    test("empty rerun_with array", () => {
      const content = `/*
---
[pgdev]
type = "routine"
rerun_with = []
---
*/
SELECT 1;`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("routine");
      expect(header!.rerun_with).toEqual([]);
    });

    test("rerun_with as single string", () => {
      const content = `/*
---
[pgdev]
type = "routine"
rerun_with = "R__extensions"
---
*/
SELECT 1;`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.rerun_with).toEqual(["R__extensions"]);
    });

    test("matches the sync-generated header format", () => {
      const content = `/*
---
[pgdev]
# Migration type: "routine" or "repeatable" or "versioned"
# For versioned, set version instead (implies versioned automatically)
type = "routine"

# Version number (implies type = "versioned"), e.g. version = "0001"
# version = ""

# Execute this file before the referenced file in the migration script
# run_before = ""

# Re-execute this file whenever any of the referenced files are executed, even if unchanged
# rerun_with = []
---
*/
drop function if exists public.my_func();
create function public.my_func() returns void as $$ begin end; $$ language plpgsql;`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("routine");
      expect(header!.version).toBeUndefined();
      expect(header!.run_before).toBeUndefined();
      expect(header!.rerun_with).toBeUndefined();
    });

    test("versioned sync-generated header", () => {
      const content = `/*
---
[pgdev]
# Migration type: "routine" or "repeatable" or "versioned"
# For versioned, set version instead (implies versioned automatically)
type = "versioned"

# Version number (implies type = "versioned"), e.g. version = "0001"
version = "000"

# Execute this file before the referenced file in the migration script
# run_before = ""

# Re-execute this file whenever any of the referenced files are executed, even if unchanged
# rerun_with = []
---
*/
CREATE TABLE foo (id serial);`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("versioned");
      expect(header!.version).toBe("000");
    });
  });

  describe("edge cases", () => {
    test("leading whitespace before header", () => {
      const content = `
-- [pgdev]
-- type = "routine"
SELECT 1;`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("routine");
    });

    test("Format 2 without closing --- returns null", () => {
      const content = `/*
---
[pgdev]
type = "routine"
*/
SELECT 1;`;
      expect(parsePgdevHeader(content)).toBeNull();
    });

    test("invalid TOML returns null", () => {
      const content = `-- [pgdev]
-- type = not_quoted
SELECT 1;`;
      expect(parsePgdevHeader(content)).toBeNull();
    });

    test("unknown type value is ignored", () => {
      const content = `-- [pgdev]
-- type = "unknown"
SELECT 1;`;
      expect(parsePgdevHeader(content)).toBeNull();
    });

    test("empty version string is ignored", () => {
      const content = `-- [pgdev]
-- type = "routine"
-- version = ""
SELECT 1;`;
      const header = parsePgdevHeader(content);
      expect(header).not.toBeNull();
      expect(header!.type).toBe("routine");
      expect(header!.version).toBeUndefined();
    });

    test("[pgdev] not at top of file returns null", () => {
      const content = `CREATE FUNCTION foo();
-- [pgdev]
-- type = "routine"`;
      expect(parsePgdevHeader(content)).toBeNull();
    });

    test("Format 2 block comment not at start returns null", () => {
      const content = `SELECT 1;
/*
---
[pgdev]
type = "routine"
---
*/`;
      expect(parsePgdevHeader(content)).toBeNull();
    });
  });
});

describe("stripPgdevHeader", () => {
  test("strips Format 2 block comment header", () => {
    const content = `/*
---
[pgdev]
type = "routine"
---
*/
CREATE FUNCTION foo();`;
    expect(stripPgdevHeader(content)).toBe("CREATE FUNCTION foo();");
  });

  test("strips Format 1 line comment header", () => {
    const content = `-- [pgdev]
-- type = "routine"
CREATE FUNCTION foo();`;
    expect(stripPgdevHeader(content)).toBe("CREATE FUNCTION foo();");
  });

  test("returns content unchanged when no header", () => {
    const content = "CREATE FUNCTION foo();";
    expect(stripPgdevHeader(content)).toBe("CREATE FUNCTION foo();");
  });

  test("strips sync-generated header", () => {
    const content = `/*
---
[pgdev]
# Migration type: "routine" or "repeatable" or "versioned"
# For versioned, set version instead (implies versioned automatically)
type = "routine"

# Version number (implies type = "versioned"), e.g. version = "0001"
# version = ""

# Execute this file before the referenced file in the migration script
# run_before = ""

# Re-execute this file whenever any of the referenced files are executed, even if unchanged
# rerun_with = []
---
*/
drop function if exists foo();
create function foo() returns void as $$ begin end; $$ language plpgsql;`;
    const stripped = stripPgdevHeader(content);
    expect(stripped).toStartWith("drop function");
    expect(stripped).not.toContain("[pgdev]");
  });

  test("preserves non-pgdev block comments", () => {
    const content = `/* regular comment */
CREATE FUNCTION foo();`;
    expect(stripPgdevHeader(content)).toBe(content);
  });
});
