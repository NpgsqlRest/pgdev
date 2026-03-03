import { beforeAll, describe, test, expect } from "bun:test";
import { query } from "../../test/db.ts";
import { parseRoutines } from "../routine.ts";
import { catalogMetadataQuery, parseCatalogRows, bodyHash, type CatalogRow } from "../catalog.ts";

const SQL = `
create function test_schema.compute_discount(
    _price numeric,
    _rate numeric
)
returns numeric
security definer
language plpgsql as
$$
declare
    _result numeric;
begin
    _result := _price * _rate;
    if _result < 0 then
        _result := 0;
    end if;
    return _result;
end;
$$;
`;

beforeAll(async () => {
  await query(SQL);
});

describe("body comparison — plpgsql function", () => {
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
