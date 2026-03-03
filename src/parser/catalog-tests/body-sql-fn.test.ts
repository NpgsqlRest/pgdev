import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, bodyHash, type CatalogRow } from "../catalog.ts";

const SQL = `
create function test_schema.full_name(
    _first text,
    _last text
)
returns text
immutable
language sql as
$$
    select _first || ' ' || _last;
$$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("body comparison — sql language function", () => {
  test("body hashes match between parser and catalog", async () => {
    const [parsed] = parseRoutines(SQL);
    const rows = await query<CatalogRow>(catalogMetadataQuery(["test_schema"]));
    const catalog = parseCatalogRows(rows);
    const match = catalog.find((c) => c.name === parsed.name && c.schema === parsed.schema);

    expect(match).toBeDefined();
    expect(parsed.body).toBeDefined();
    expect(match!.body).toBeDefined();
    expect(bodyHash(parsed.body!)).toBe(bodyHash(match!.body!));
  });
});
