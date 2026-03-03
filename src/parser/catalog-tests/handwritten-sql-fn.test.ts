import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
create function test_schema.format_order_summary(
    _order_id integer,
    _include_tax boolean = true
)
returns text
stable
language sql as
$$
    select
        'Order #' || _order_id::text
        || case when _include_tax then ' (tax incl.)' else '' end;
$$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("hand-written sql language function", () => {
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

    expect(match.parameters).toHaveLength(parsed.parameters.length);
    const parsedNames = parsed.parameters.map((p) => p.name);
    const catalogNames = match.parameters.map((p) => p.name);
    expect(catalogNames).toEqual(parsedNames);
  });

  test("return type matches catalog", async () => {
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "format_order_summary")!;

    expect(match.returns).toEqual({ setof: false, type: "text" });
  });
});
