import { describe, test, expect } from "bun:test";
import { parseRoutines } from "../routine.ts";

describe("parseRoutines — hand-written SQL style", () => {
  test("multi-line params with 4-space indent", () => {
    const sql = `create function inventory.create_order(
    _customer_id integer,
    _product_id integer,
    _quantity integer
)
returns integer
security definer
language plpgsql as
$$
begin
    return 1;
end;
$$;`;
    const [r] = parseRoutines(sql);
    expect(r.name).toBe("create_order");
    expect(r.schema).toBe("inventory");
    expect(r.parameters).toHaveLength(3);
    expect(r.parameters[0]).toEqual({ dir: null, name: "_customer_id", type: "integer" });
    expect(r.parameters[1]).toEqual({ dir: null, name: "_product_id", type: "integer" });
    expect(r.parameters[2]).toEqual({ dir: null, name: "_quantity", type: "integer" });
  });

  test("defaults with = instead of DEFAULT", () => {
    const sql = `create function inventory.search_products(
    _category text,
    _min_price numeric = 0,
    _limit integer = 50
)
returns setof record
language plpgsql as
$$
begin
    return query select 1;
end;
$$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toHaveLength(3);
    expect(r.parameters[0]).toEqual({ dir: null, name: "_category", type: "text" });
    expect(r.parameters[1]).toEqual({ dir: null, name: "_min_price", type: "numeric" });
    expect(r.parameters[2]).toEqual({ dir: null, name: "_limit", type: "integer" });
  });

  test("attributes on separate lines", () => {
    const sql = `create function inventory.compute_tax(
    _amount numeric,
    _rate double precision
)
returns numeric
immutable
parallel safe
strict
language sql as
$$
    select _amount * _rate;
$$;`;
    const [r] = parseRoutines(sql);
    expect(r.name).toBe("compute_tax");
    expect(r.attributes).toContain("immutable");
    expect(r.attributes).toContain("parallel safe");
    expect(r.attributes).toContain("strict");
    expect(r.attributes).toContain("language sql");
  });

  test("$$ on its own line after as", () => {
    const sql = `create function inventory.get_name(_id integer)
returns text
language sql as
$$
    select 'item-' || _id::text;
$$;`;
    const [r] = parseRoutines(sql);
    expect(r.name).toBe("get_name");
    expect(r.body).toContain("select 'item-' || _id::text;");
  });

  test("procedure with declare block and comments", () => {
    const sql = `create procedure inventory.restock(
    _product_id integer,
    _quantity integer,
    _user_id text = null
)
security definer
language plpgsql as
$$
declare
    _current_stock integer;
begin
    -- look up current stock level
    _current_stock := 0;

    -- update stock
    raise notice 'restocked % units for product %, new total: %',
        _quantity, _product_id, _current_stock + _quantity;
end;
$$;`;
    const [r] = parseRoutines(sql);
    expect(r.name).toBe("restock");
    expect(r.type).toBe("procedure");
    expect(r.parameters).toHaveLength(3);
    expect(r.parameters[2]).toEqual({ dir: null, name: "_user_id", type: "text" });
    expect(r.body).toContain("declare");
    expect(r.body).toContain("-- look up current stock level");
    expect(r.body).toContain("raise notice");
  });

  test("body with CTE (with ... insert ... returning)", () => {
    const sql = `create function inventory.log_action(
    _action text,
    _user_id integer
)
returns integer
security definer
language sql as
$$
    with inserted as (
        insert into inventory.audit_log
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
$$;`;
    const [r] = parseRoutines(sql);
    expect(r.name).toBe("log_action");
    expect(r.body).toContain("with inserted as");
    expect(r.body).toContain("insert into inventory.audit_log");
    expect(r.body).toContain("returning id");
  });

  test("mixed: hand-written + pg_dump style in same input", () => {
    const sql = `create function inventory.get_total(
    _order_id integer
)
returns numeric
stable
language sql as
$$
    select sum(price)
    from inventory.order_items
    where order_id = _order_id;
$$;

CREATE FUNCTION inventory.format_price(_amount numeric, _currency text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT _currency || _amount::text; $$;`;
    const results = parseRoutines(sql);
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("get_total");
    expect(results[0].parameters).toHaveLength(1);
    expect(results[1].name).toBe("format_price");
    expect(results[1].parameters).toHaveLength(2);
  });

  test("returns table with multi-line params", () => {
    const sql = `create function inventory.list_orders(
    _customer_id integer,
    _status text = 'active'
)
returns table(
    id integer,
    total numeric,
    created_at timestamp with time zone
)
security definer
language plpgsql as
$$
begin
    return query
    select
        o.id,
        o.total,
        o.created_at
    from inventory.orders o
    where o.customer_id = _customer_id
      and o.status = _status;
end;
$$;`;
    const [r] = parseRoutines(sql);
    expect(r.name).toBe("list_orders");
    expect(r.parameters).toHaveLength(2);
    expect(r.returns).toBeDefined();
    expect(r.returns!.table).toHaveLength(3);
    expect(r.returns!.table![0]).toEqual({ name: "id", type: "integer" });
    expect(r.returns!.table![2]).toEqual({ name: "created_at", type: "timestamp with time zone" });
  });

  test("array params with = default", () => {
    const sql = `create function inventory.filter_items(
    _tags text[] = array[]::text[],
    _ids integer[] = '{}'::integer[]
)
returns void
language sql as
$$
    select 1;
$$;`;
    const [r] = parseRoutines(sql);
    expect(r.parameters).toHaveLength(2);
    expect(r.parameters[0]).toEqual({ dir: null, name: "_tags", type: "text[]" });
    expect(r.parameters[1]).toEqual({ dir: null, name: "_ids", type: "integer[]" });
  });
});
