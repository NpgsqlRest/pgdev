import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";
import { expectAttributesMatch } from "./attribute-helper.ts";

const SQL = `
create procedure test_schema.archive_orders(
    _older_than_days integer,
    _user_id text = null,
    _dry_run boolean = false
)
security definer
language plpgsql as
$$
declare
    _affected integer;
begin
    if _dry_run then
        raise notice 'dry run mode, no changes will be made';
        return;
    end if;

    -- archive old orders
    _affected := 0;
    raise notice 'archived % orders for user %', _affected, coalesce(_user_id, 'system');
end;
$$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("hand-written procedure", () => {
  test("name and type match catalog", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

    expect(match).toBeDefined();
    expect(match!.type).toBe("procedure");
  });

  test("parameter count matches catalog", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name)!;

    expect(match.parameters).toHaveLength(parsed.parameters.length);
  });

  test("parameter names match catalog", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name)!;

    const parsedNames = parsed.parameters.map((p) => p.name);
    const catalogNames = match.parameters.map((p) => p.name);
    expect(catalogNames).toEqual(parsedNames);
  });

  test("procedure has null returns", async () => {
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "archive_orders")!;

    expect(match.returns).toBeNull();
  });

  test("attributes match catalog", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name)!;

    expectAttributesMatch(match, parsed);
  });
});
