import { expect } from "bun:test";
import type { ParsedRoutine } from "../routine.ts";
import type { CatalogRoutine } from "../catalog.ts";
import { attributesToCatalog } from "../compare.ts";

export { attributesToCatalog } from "../compare.ts";

/**
 * Assert that ALL catalog attribute fields match what the parser extracted,
 * with PostgreSQL defaults applied for unspecified attributes.
 */
export function expectAttributesMatch(catalog: CatalogRoutine, parsed: ParsedRoutine): void {
  const expected = attributesToCatalog(parsed);

  expect(catalog.language).toBe(expected.language);
  expect(catalog.volatility).toBe(expected.volatility);
  expect(catalog.strict).toBe(expected.strict);
  expect(catalog.securityDefiner).toBe(expected.securityDefiner);
  expect(catalog.parallel).toBe(expected.parallel);
  expect(catalog.leakproof).toBe(expected.leakproof);
  expect(catalog.cost).toBe(expected.cost);
  expect(catalog.rows).toBe(expected.rows);
  expect(catalog.config).toEqual(expected.config);
}
