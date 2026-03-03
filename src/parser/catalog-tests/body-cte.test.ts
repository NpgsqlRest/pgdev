import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, bodyHash, type CatalogRow } from "../catalog.ts";

const SQL = `
create table test_schema.event_log (
    id serial primary key,
    event_type text,
    payload text
);

create function test_schema.log_event(
    _type text,
    _payload text
)
returns integer
security definer
language sql as
$$
    with inserted as (
        insert into test_schema.event_log (event_type, payload)
        values (_type, _payload)
        returning id
    )
    select id from inserted;
$$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("body comparison — function with CTE", () => {
  test("body hashes match between parser and catalog", async () => {
    const parsed = parseRoutines(SQL);
    const fn = parsed.find((r) => r.name === "log_event")!;
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === fn.name && c.schema === fn.schema);

    expect(match).toBeDefined();
    expect(fn.body).toBeDefined();
    expect(match!.body).toBeDefined();
    expect(bodyHash(fn.body!)).toBe(bodyHash(match!.body!));
  });
});
