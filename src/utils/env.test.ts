import { describe, test, expect } from "bun:test";
import { resolvePlaceholders } from "./env.ts";

describe("resolvePlaceholders", () => {
  test("replaces a single placeholder", () => {
    const { resolved, unresolved } = resolvePlaceholders("hello {name}", { name: "world" });
    expect(resolved).toBe("hello world");
    expect(unresolved).toEqual([]);
  });

  test("replaces multiple placeholders", () => {
    const { resolved } = resolvePlaceholders("{a}_{b}_{c}", { a: "1", b: "2", c: "3" });
    expect(resolved).toBe("1_2_3");
  });

  test("replaces same placeholder multiple times", () => {
    const { resolved } = resolvePlaceholders("{x}+{x}", { x: "5" });
    expect(resolved).toBe("5+5");
  });

  test("returns unresolved keys for missing placeholders", () => {
    const { resolved, unresolved } = resolvePlaceholders("{a}_{b}", { a: "1" });
    expect(resolved).toBe("1_{b}");
    expect(unresolved).toEqual(["b"]);
  });

  test("returns string unchanged when no placeholders", () => {
    const { resolved, unresolved } = resolvePlaceholders("no placeholders here", { x: "1" });
    expect(resolved).toBe("no placeholders here");
    expect(unresolved).toEqual([]);
  });

  test("returns empty string unchanged", () => {
    const { resolved } = resolvePlaceholders("", { x: "1" });
    expect(resolved).toBe("");
  });

  test("handles empty dictionary", () => {
    const { resolved, unresolved } = resolvePlaceholders("{a}_{b}", {});
    expect(resolved).toBe("{a}_{b}");
    expect(unresolved).toEqual(["a", "b"]);
  });

  test("replaces with empty string value", () => {
    const { resolved } = resolvePlaceholders("pre{x}post", { x: "" });
    expect(resolved).toBe("prepost");
  });

  test("handles adjacent placeholders", () => {
    const { resolved } = resolvePlaceholders("{a}{b}", { a: "1", b: "2" });
    expect(resolved).toBe("12");
  });

  test("nested braces — inner key includes leading brace", () => {
    // {{a}} matches {a as the key (regex is greedy non-}), so it stays unresolved
    const { resolved, unresolved } = resolvePlaceholders("{{a}}", { a: "1" });
    expect(resolved).toBe("{{a}}");
    expect(unresolved).toEqual(["{a"]);
  });

  test("handles special regex characters in values", () => {
    const { resolved } = resolvePlaceholders("{x}", { x: "$1.00 (test)" });
    expect(resolved).toBe("$1.00 (test)");
  });
});
