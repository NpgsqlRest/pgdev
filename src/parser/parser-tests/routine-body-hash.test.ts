import { describe, test, expect } from "bun:test";
import { normalizeBody, normalizeBodyNoWhitespace, bodyHash } from "../catalog.ts";

describe("normalizeBody", () => {
  test("lowercases content", () => {
    expect(normalizeBody("SELECT 1")).toBe("select 1");
  });

  test("preserves internal whitespace structure", () => {
    // New behavior: spaces are NOT collapsed — whitespace differences are meaningful
    expect(normalizeBody("select   _a   +   _b")).toBe("select   _a   +   _b");
  });

  test("preserves newlines but trims trailing spaces per line", () => {
    expect(normalizeBody("select\n    _a\n    +\n    _b;")).toBe("select\n    _a\n    +\n    _b;");
  });

  test("trims leading and trailing whitespace", () => {
    expect(normalizeBody("  \n  select 1;  \n  ")).toBe("select 1;");
  });

  test("replaces non-printable characters with space", () => {
    expect(normalizeBody("select\x001")).toBe("select 1");
  });

  test("normalizes CRLF to LF", () => {
    expect(normalizeBody("select\r\n_a")).toBe("select\n_a");
  });

  test("collapses 3+ blank lines to 2", () => {
    expect(normalizeBody("select 1;\n\n\n\nselect 2;")).toBe("select 1;\n\nselect 2;");
  });

  test("different formatting produces different hash in strict mode", () => {
    const a = "  SELECT\n    _price * _rate;\n";
    const b = "select _price * _rate;";
    // These have different whitespace structure — strict mode should detect this
    expect(normalizeBody(a)).not.toBe(normalizeBody(b));
  });

  test("identical formatting normalizes the same", () => {
    const a = "select\n  _price * _rate;";
    const b = "SELECT\n  _price * _rate;";
    expect(normalizeBody(a)).toBe(normalizeBody(b));
  });
});

describe("bodyHash", () => {
  test("same content produces same hash", () => {
    expect(bodyHash("select 1")).toBe(bodyHash("select 1"));
  });

  test("same content with case difference produces same hash", () => {
    const a = "SELECT _a + _b;";
    const b = "select _a + _b;";
    expect(bodyHash(a)).toBe(bodyHash(b));
  });

  test("different whitespace produces different hash in strict mode", () => {
    const a = "select _a + _b;";
    const b = "select  _a  +  _b;";
    expect(bodyHash(a)).not.toBe(bodyHash(b));
  });

  test("different content produces different hash", () => {
    expect(bodyHash("select 1")).not.toBe(bodyHash("select 2"));
  });

  test("returns 64-char hex string (SHA-256)", () => {
    const hash = bodyHash("select 1");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("ignoreWhitespace: spaces around punctuation don't matter", () => {
    const a = "select fn(type, success)";
    const b = "select fn( type,success )";
    expect(bodyHash(a)).not.toBe(bodyHash(b)); // strict mode: different
    expect(bodyHash(a, true)).toBe(bodyHash(b, true)); // ignore mode: same
  });

  test("ignoreWhitespace: line break inside expression doesn't matter", () => {
    const a = "select fn(type, success)";
    const b = "select fn(type,\nsuccess)";
    expect(bodyHash(a, true)).toBe(bodyHash(b, true));
  });

  test("ignoreWhitespace: actual code change still detected", () => {
    const a = "select fn(type, success)";
    const b = "select fn(type, failure)";
    expect(bodyHash(a, true)).not.toBe(bodyHash(b, true));
  });
});

describe("normalizeBodyNoWhitespace", () => {
  test("removes all whitespace", () => {
    expect(normalizeBodyNoWhitespace("select  _a  +  _b")).toBe("select_a+_b");
  });

  test("lowercases", () => {
    expect(normalizeBodyNoWhitespace("SELECT 1")).toBe("select1");
  });

  test("strips non-printable characters", () => {
    expect(normalizeBodyNoWhitespace("select\x001")).toBe("select1");
  });
});
