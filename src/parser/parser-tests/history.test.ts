import { describe, test, expect, beforeAll } from "bun:test";
import { createTestDb, loadTestConfig, query, runSetupScript } from "../../test/db.ts";
import { fetchHistory } from "../history.ts";
import type { PgdevConfig } from "../../config.ts";
import { loadConfig } from "../../config.ts";

let baseConfig: PgdevConfig;
let testConfig: Awaited<ReturnType<typeof loadTestConfig>>;

beforeAll(async () => {
  await createTestDb();
  await runSetupScript();
  testConfig = await loadTestConfig();
  baseConfig = await loadConfig();

  // Override connection to use test database
  baseConfig.connection = {
    host: testConfig.host,
    port: testConfig.port,
    database: testConfig.database,
    username: testConfig.user,
    password: testConfig.password,
  };
});

describe("fetchHistory — comment mode", () => {
  test("returns empty entries when no comment exists", async () => {
    const config = {
      ...baseConfig,
      project: { ...baseConfig.project, history_mode: "comment" as const, project_name: "test_project" },
    };
    const result = await fetchHistory(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([]);
    }
  });

  test("returns error when project_name is empty", async () => {
    const config = {
      ...baseConfig,
      project: { ...baseConfig.project, history_mode: "comment" as const, project_name: "" },
    };
    const result = await fetchHistory(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("project_name");
    }
  });

  test("reads history from database comment", async () => {
    const projectName = "history_test_read";
    const migrations = [
      { name: "V001 schema", type: "VERSIONED", version: "001", hash: "abc123" },
      { name: "R seed", type: "REPEATABLE", hash: "def456" },
    ];
    const commentData = JSON.stringify({ pgdev: { [projectName]: { migrations } } });
    await query(`COMMENT ON DATABASE "${testConfig.database}" IS '${commentData.replace(/'/g, "''")}'`);

    const config = {
      ...baseConfig,
      project: { ...baseConfig.project, history_mode: "comment" as const, project_name: projectName },
    };
    const result = await fetchHistory(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.length).toBe(2);
      expect(result.entries[0].name).toBe("V001 schema");
      expect(result.entries[0].type).toBe("VERSIONED");
      expect(result.entries[0].version).toBe("001");
      expect(result.entries[0].hash).toBe("abc123");
      expect(result.entries[1].name).toBe("R seed");
    }

    // Clean up
    await query(`COMMENT ON DATABASE "${testConfig.database}" IS NULL`);
  });

  test("returns empty for non-JSON database comment", async () => {
    await query(`COMMENT ON DATABASE "${testConfig.database}" IS 'just a plain text comment'`);

    const config = {
      ...baseConfig,
      project: { ...baseConfig.project, history_mode: "comment" as const, project_name: "some_project" },
    };
    const result = await fetchHistory(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([]);
    }

    // Clean up
    await query(`COMMENT ON DATABASE "${testConfig.database}" IS NULL`);
  });

  test("returns empty when project_name not in comment", async () => {
    const commentData = JSON.stringify({ pgdev: { other_project: { migrations: [{ name: "x", type: "VERSIONED", hash: "y" }] } } });
    await query(`COMMENT ON DATABASE "${testConfig.database}" IS '${commentData.replace(/'/g, "''")}'`);

    const config = {
      ...baseConfig,
      project: { ...baseConfig.project, history_mode: "comment" as const, project_name: "my_project" },
    };
    const result = await fetchHistory(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([]);
    }

    // Clean up
    await query(`COMMENT ON DATABASE "${testConfig.database}" IS NULL`);
  });
});

describe("fetchHistory — table mode", () => {
  test("returns empty entries when table does not exist", async () => {
    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        history_mode: "table" as const,
        history_schema: "pgdev_test_hist",
        history_table: "nonexistent_history",
      },
    };
    const result = await fetchHistory(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([]);
    }
  });

  test("reads history from table", async () => {
    // Create schema and table
    await query(`CREATE SCHEMA IF NOT EXISTS pgdev_test_hist`);
    await query(`CREATE TABLE pgdev_test_hist.test_history (
      name text NOT NULL,
      type text NOT NULL,
      version text,
      hash text NOT NULL,
      installed_by text NOT NULL DEFAULT current_user,
      installed_on timestamptz NOT NULL DEFAULT now(),
      execution_time interval NOT NULL DEFAULT '0'::interval,
      PRIMARY KEY (name, type)
    )`);
    await query(`INSERT INTO pgdev_test_hist.test_history (name, type, version, hash) VALUES
      ('V001 schema', 'VERSIONED', '001', 'abc123'),
      ('R seed', 'REPEATABLE', NULL, 'def456')`);

    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        history_mode: "table" as const,
        history_schema: "pgdev_test_hist",
        history_table: "test_history",
      },
    };
    const result = await fetchHistory(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.length).toBe(2);
      expect(result.entries[0].name).toBe("V001 schema");
      expect(result.entries[0].type).toBe("VERSIONED");
      expect(result.entries[0].version).toBe("001");
      expect(result.entries[1].name).toBe("R seed");
      expect(result.entries[1].type).toBe("REPEATABLE");
    }
  });

  test("derives table name from project_name", async () => {
    await query(`CREATE SCHEMA IF NOT EXISTS pgdev_test_hist`);
    await query(`CREATE TABLE IF NOT EXISTS pgdev_test_hist.myapp_history (
      name text NOT NULL,
      type text NOT NULL,
      version text,
      hash text NOT NULL,
      installed_by text NOT NULL DEFAULT current_user,
      installed_on timestamptz NOT NULL DEFAULT now(),
      execution_time interval NOT NULL DEFAULT '0'::interval,
      PRIMARY KEY (name, type)
    )`);
    await query(`INSERT INTO pgdev_test_hist.myapp_history (name, type, version, hash) VALUES
      ('V001 init', 'VERSIONED', '001', 'xyz')
      ON CONFLICT DO NOTHING`);

    const config = {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        history_mode: "table" as const,
        history_schema: "pgdev_test_hist",
        history_table: "",
        project_name: "myapp",
      },
    };
    const result = await fetchHistory(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].name).toBe("V001 init");
    }
  });
});
