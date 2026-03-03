import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";
import { expectAttributesMatch } from "./attribute-helper.ts";

const SQL = `
create function test_schema.safe_divide(
    _numerator double precision,
    _denominator double precision
)
returns double precision
immutable
parallel safe
strict
language sql as
$$
    select
        case
            when _denominator = 0 then null
            else _numerator / _denominator
        end;
$$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("hand-written function with multi-line attributes", () => {
  test("name and type match catalog", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

    expect(match).toBeDefined();
    expect(match!.type).toBe("function");
  });

  test("parameters match catalog", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name)!;

    expect(match.parameters).toHaveLength(2);
    const parsedNames = parsed.parameters.map((p) => p.name);
    const catalogNames = match.parameters.map((p) => p.name);
    expect(catalogNames).toEqual(parsedNames);

    const parsedTypes = parsed.parameters.map((p) => p.type);
    const catalogTypes = match.parameters.map((p) => p.type);
    expect(catalogTypes).toEqual(parsedTypes);
  });

  test("return type matches catalog", async () => {
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "safe_divide")!;

    expect(match.returns).toEqual({ setof: false, type: "double precision" });
  });

  test("attributes match catalog", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name)!;

    expectAttributesMatch(match, parsed);
  });
});
