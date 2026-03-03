import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, bodyHash, type CatalogRow } from "../catalog.ts";
import { routinesDiffer } from "../compare.ts";
import { expectAttributesMatch } from "./attribute-helper.ts";

// Random casing, tabs mixed with spaces, newlines in absurd places
const SQL = `
CrEaTe   oR
	rEpLaCe
FUNCTION	test_schema.chaotic_casing(
	_val		INTEGER,
	_label
		TEXT
		DEFAULT    'hello'
)
	RETURNS
		text
	lAnGuAgE
		sQl
	IMMUTABLE
	PARALLEL
		SAFE
AS
$$
	SELECT _label || ': ' || _val::text;
$$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("chaotic casing and whitespace", () => {
  test("parser and catalog agree", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

    expect(match).toBeDefined();
    expect(routinesDiffer(parsed, match!)).toBe(false);
  });

  test("parameters match despite whitespace chaos", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name)!;

    expect(match.parameters).toHaveLength(parsed.parameters.length);
    const parsedNames = parsed.parameters.map((p) => p.name);
    const catalogNames = match.parameters.map((p) => p.name);
    expect(catalogNames).toEqual(parsedNames);
  });

  test("attributes match catalog", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name)!;

    expectAttributesMatch(match, parsed);
  });

  test("body hashes match", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name)!;

    expect(bodyHash(parsed.body!)).toBe(bodyHash(match.body!));
  });
});
