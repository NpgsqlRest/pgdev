import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, type CatalogRow } from "../catalog.ts";

const SQL = `
create table test_schema.audit_log (
    id serial primary key,
    action text,
    created_by integer
);

create function test_schema.log_and_return(
    _action text,
    _user_id integer
)
returns integer
security definer
language sql as
$$
    with inserted as (
        insert into test_schema.audit_log
        (
            action,
            created_by
        )
        values (
            _action,
            _user_id
        )
        returning id
    )
    select id from inserted;
$$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("hand-written function with CTE body", () => {
  test("name and type match catalog", async () => {
    const parsed = parseRoutines(SQL);
    const fn = parsed.find((r) => r.name === "log_and_return")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === fn.name && c.schema === fn.schema);

    expect(match).toBeDefined();
    expect(match!.type).toBe("function");
  });

  test("parameters match catalog", async () => {
    const parsed = parseRoutines(SQL);
    const fn = parsed.find((r) => r.name === "log_and_return")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === fn.name)!;

    expect(match.parameters).toHaveLength(fn.parameters.length);
    const parsedNames = fn.parameters.map((p) => p.name);
    const catalogNames = match.parameters.map((p) => p.name);
    expect(catalogNames).toEqual(parsedNames);
  });
});
