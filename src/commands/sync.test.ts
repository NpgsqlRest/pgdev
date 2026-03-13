import { describe, test, expect } from "bun:test";
import { parseRoutineGroups } from "./sync.ts";

const SAMPLE_TOC = `
;
; Archive created at 2026-03-03 11:10:30 CET
;     dbname: shopdb
;
; Selected TOC Entries:
;
42; 2615 586319 SCHEMA - inventory shopdb
5799; 0 0 COMMENT - SCHEMA inventory shopdb
1290; 1255 586699 FUNCTION inventory get_product(integer) shopdb
5801; 0 0 COMMENT inventory FUNCTION get_product(_product_id integer) shopdb
1495; 1255 586705 PROCEDURE inventory restock_item(integer, integer) shopdb
5802; 0 0 COMMENT inventory PROCEDURE restock_item(IN _item_id integer, IN _quantity integer) shopdb
1057; 1255 586617 FUNCTION inventory check_availability(text, integer) shopdb
1484; 1255 586612 FUNCTION inventory format_price(numeric, text) shopdb
1424; 1255 586611 FUNCTION inventory format_price(numeric, text, boolean) shopdb
540; 1259 586428 TABLE inventory products shopdb
`;

describe("parseRoutineGroups", () => {
  const groups = parseRoutineGroups(SAMPLE_TOC);

  test("extracts correct number of routine groups", () => {
    expect(groups.length).toBe(4);
  });

  test("preserves order of first appearance", () => {
    expect(groups.map((g) => g.name)).toEqual([
      "get_product",
      "restock_item",
      "check_availability",
      "format_price",
    ]);
  });

  test("captures schema from TOC", () => {
    const product = groups.find((g) => g.name === "get_product")!;
    expect(product.schema).toBe("inventory");
  });

  test("captures routineType from TOC", () => {
    const product = groups.find((g) => g.name === "get_product")!;
    expect(product.routineType).toBe("function");
    const restock = groups.find((g) => g.name === "restock_item")!;
    expect(restock.routineType).toBe("procedure");
  });

  test("includes COMMENT lines with the routine", () => {
    const product = groups.find((g) => g.name === "get_product")!;
    expect(product.tocLines.length).toBe(2);
    expect(product.tocLines[0]).toContain("FUNCTION");
    expect(product.tocLines[1]).toContain("COMMENT");
  });

  test("groups overloaded functions together", () => {
    const format = groups.find((g) => g.name === "format_price")!;
    expect(format.tocLines.length).toBe(2);
    expect(format.tocLines[0]).toContain("numeric, text)");
    expect(format.tocLines[1]).toContain("boolean)");
  });

  test("handles functions without comments", () => {
    const avail = groups.find((g) => g.name === "check_availability")!;
    expect(avail.tocLines.length).toBe(1);
    expect(avail.tocLines[0]).toContain("FUNCTION");
  });

  test("handles procedures", () => {
    const restock = groups.find((g) => g.name === "restock_item")!;
    expect(restock.tocLines.length).toBe(2);
    expect(restock.tocLines[0]).toContain("PROCEDURE");
    expect(restock.tocLines[1]).toContain("COMMENT");
  });

  test("ignores non-routine TOC entries", () => {
    const allNames = groups.map((g) => g.name);
    expect(allNames).not.toContain("inventory");
    expect(allNames).not.toContain("products");
  });

  test("excludes ACL lines by default", () => {
    const tocWithAcl = `
1290; 1255 586699 FUNCTION inventory get_product(integer) shopdb
5800; 0 0 ACL inventory FUNCTION get_product(_product_id integer) shopdb
`;
    const result = parseRoutineGroups(tocWithAcl);
    expect(result[0].tocLines.length).toBe(1);
    expect(result[0].tocLines[0]).toContain("FUNCTION");
  });

  test("includes ACL lines when includeGrants=true", () => {
    const tocWithAcl = `
1290; 1255 586699 FUNCTION inventory get_product(integer) shopdb
5800; 0 0 ACL inventory FUNCTION get_product(_product_id integer) shopdb
`;
    const result = parseRoutineGroups(tocWithAcl, { includeGrants: true });
    expect(result[0].tocLines.length).toBe(2);
    expect(result[0].tocLines[1]).toContain("ACL");
  });

  test("returns empty array for TOC with no routines", () => {
    const empty = parseRoutineGroups(`;
; Archive header
;
42; 2615 586319 SCHEMA - inventory shopdb
540; 1259 586428 TABLE inventory products shopdb
`);
    expect(empty).toEqual([]);
  });

  test("filters by custom routineTypes", () => {
    const functionsOnly = parseRoutineGroups(SAMPLE_TOC, { routineTypes: ["FUNCTION"] });
    expect(functionsOnly.length).toBe(3);
    expect(functionsOnly.every((g) => g.routineType === "function")).toBe(true);
    expect(functionsOnly.map((g) => g.name)).not.toContain("restock_item");
  });

  test("includes AGGREGATE when in routineTypes", () => {
    const tocWithAgg = `
1290; 1255 586699 FUNCTION inventory get_product(integer) shopdb
1500; 1255 586800 AGGREGATE inventory avg_price(numeric) shopdb
`;
    const result = parseRoutineGroups(tocWithAgg, { routineTypes: ["FUNCTION", "AGGREGATE"] });
    expect(result.length).toBe(2);
    expect(result[1].name).toBe("avg_price");
    expect(result[1].routineType).toBe("aggregate");
    expect(result[1].schema).toBe("inventory");
  });

  test("parses VIEW TOC entries (no parentheses)", () => {
    const tocWithView = `
1290; 1255 586699 FUNCTION inventory get_product(integer) shopdb
1300; 1259 586800 VIEW inventory product_summary shopdb
`;
    const result = parseRoutineGroups(tocWithView, { routineTypes: ["FUNCTION", "VIEW"] });
    expect(result.length).toBe(2);
    expect(result[1].name).toBe("product_summary");
    expect(result[1].routineType).toBe("view");
    expect(result[1].schema).toBe("inventory");
  });

  test("VIEW COMMENT lines are grouped with the view", () => {
    const toc = `
1300; 1259 586800 VIEW inventory product_summary shopdb
5803; 0 0 COMMENT inventory VIEW product_summary shopdb
`;
    const result = parseRoutineGroups(toc, { routineTypes: ["VIEW"] });
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("product_summary");
    expect(result[0].tocLines.length).toBe(2);
    expect(result[0].tocLines[1]).toContain("COMMENT");
  });

  test("VIEW ACL lines are included with includeGrants", () => {
    const toc = `
1300; 1259 586800 VIEW inventory product_summary shopdb
5804; 0 0 ACL inventory VIEW product_summary shopdb
`;
    const result = parseRoutineGroups(toc, { routineTypes: ["VIEW"], includeGrants: true });
    expect(result[0].tocLines.length).toBe(2);
    expect(result[0].tocLines[1]).toContain("ACL");
  });

  test("mixed FUNCTION and VIEW types in same TOC", () => {
    const toc = `
1290; 1255 586699 FUNCTION inventory get_product(integer) shopdb
5801; 0 0 COMMENT inventory FUNCTION get_product(_product_id integer) shopdb
1300; 1259 586800 VIEW inventory product_summary shopdb
5803; 0 0 COMMENT inventory VIEW product_summary shopdb
1495; 1255 586705 PROCEDURE inventory restock_item(integer, integer) shopdb
`;
    const result = parseRoutineGroups(toc, { routineTypes: ["FUNCTION", "PROCEDURE", "VIEW"] });
    expect(result.length).toBe(3);
    expect(result.map((g) => g.name)).toEqual(["get_product", "product_summary", "restock_item"]);
    expect(result[0].routineType).toBe("function");
    expect(result[0].tocLines.length).toBe(2);
    expect(result[1].routineType).toBe("view");
    expect(result[1].tocLines.length).toBe(2);
    expect(result[2].routineType).toBe("procedure");
    expect(result[2].tocLines.length).toBe(1);
  });
});
