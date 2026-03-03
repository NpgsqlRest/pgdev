import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";
import { expectAttributesMatch } from "./attribute-helper.ts";

const SQL = `
create function test_schema.find_active_users(
    _min_age integer,
    _status text,
    _limit integer = 100
)
returns setof record
security definer
language plpgsql as
$$
declare
    _count integer;
begin
    -- count matching users first
    select count(*)
    into _count
    from test_schema.stub_table
    where id > _min_age;

    if _count = 0 then
        raise notice 'no users found for status: %', _status;
    end if;

    return query
    select 1;
end;
$$;

create table test_schema.stub_table (id integer);
`;

beforeAll(async () => {
  await query(SQL);
});

describe("hand-written plpgsql function", () => {
  test("name and type match catalog", async () => {
    const parsed = parseRoutines(SQL);
    const fn = parsed.find((r) => r.name === "find_active_users")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "find_active_users")!;

    expect(match).toBeDefined();
    expect(match.type).toBe(fn.type);
  });

  test("parameter count matches catalog", async () => {
    const parsed = parseRoutines(SQL);
    const fn = parsed.find((r) => r.name === "find_active_users")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "find_active_users")!;

    expect(match.parameters).toHaveLength(fn.parameters.length);
  });

  test("parameter names match catalog", async () => {
    const parsed = parseRoutines(SQL);
    const fn = parsed.find((r) => r.name === "find_active_users")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "find_active_users")!;

    const parsedNames = fn.parameters.map((p) => p.name);
    const catalogNames = match.parameters.map((p) => p.name);
    expect(catalogNames).toEqual(parsedNames);
  });

  test("return type matches catalog", async () => {
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "find_active_users")!;

    expect(match.returns).toEqual({ setof: true, type: "record" });
  });

  test("attributes match catalog", async () => {
    const parsed = parseRoutines(SQL);
    const fn = parsed.find((r) => r.name === "find_active_users")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === "find_active_users")!;

    expectAttributesMatch(match, fn);
  });
});
