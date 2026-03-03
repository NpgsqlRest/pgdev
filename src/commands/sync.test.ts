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

  test("returns empty array for TOC with no routines", () => {
    const empty = parseRoutineGroups(`;
; Archive header
;
42; 2615 586319 SCHEMA - inventory shopdb
540; 1259 586428 TABLE inventory products shopdb
`);
    expect(empty).toEqual([]);
  });
});
