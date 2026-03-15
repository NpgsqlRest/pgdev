import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { scanProjectFiles, type ScanOptions } from "../scanner.ts";

const testDir = resolve(tmpdir(), `pgdev-scanner-test-${Date.now()}`);

const defaultOpts: ScanOptions = {
  upPrefix: "V",
  repeatablePrefix: "R",
  separator: "__",
};

function writeFile(relPath: string, content: string): void {
  const fullPath = resolve(testDir, relPath);
  const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
}

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });

  // Versioned files
  writeFile("V000__schema.sql", `/*
---
[pgdev]
type = "versioned"
version = "000"
---
*/
CREATE TABLE users (id serial);`);

  writeFile("V001__add_email.sql", `CREATE TABLE emails (id serial);`);

  // Repeatable file
  writeFile("R__seed_data.sql", `INSERT INTO users (id) VALUES (1);`);

  // Routine file in subdirectory (implicit detection)
  writeFile("api/mathmodule/add.sql", `CREATE OR REPLACE FUNCTION mathmodule.add(a int, b int) RETURNS int AS $$ BEGIN RETURN a + b; END; $$ LANGUAGE plpgsql;`);

  // Routine file with explicit header
  writeFile("api/mathmodule/subtract.sql", `/*
---
[pgdev]
type = "routine"
---
*/
CREATE OR REPLACE FUNCTION mathmodule.subtract(a int, b int) RETURNS int AS $$ BEGIN RETURN a - b; END; $$ LANGUAGE plpgsql;`);

  // Explicit header overriding naming convention
  writeFile("R__actually_versioned.sql", `/*
---
[pgdev]
version = "099"
---
*/
ALTER TABLE users ADD COLUMN name text;`);

  // Contradictory header: version + repeatable
  writeFile("bad_contradictory.sql", `/*
---
[pgdev]
type = "repeatable"
version = "001"
---
*/
SELECT 1;`);

  // Explicit routine type but no valid routine
  writeFile("bad_routine.sql", `/*
---
[pgdev]
type = "routine"
---
*/
SELECT 1;`);

  // Unrecognized file — no header, no prefix, no routine
  writeFile("random_notes.sql", `-- just some notes
SELECT current_timestamp;`);

  // Versioned header without version and no filename convention
  writeFile("bad_versioned.sql", `/*
---
[pgdev]
type = "versioned"
---
*/
SELECT 1;`);

  // Routine with run_before and rerun_with
  writeFile("api/mathmodule/multiply.sql", `/*
---
[pgdev]
type = "routine"
run_before = "R__seed_data"
rerun_with = ["R__seed_data"]
---
*/
CREATE OR REPLACE FUNCTION mathmodule.multiply(a int, b int) RETURNS int AS $$ BEGIN RETURN a * b; END; $$ LANGUAGE plpgsql;`);

  // Repeatable with explicit header
  writeFile("R__views.sql", `/*
---
[pgdev]
type = "repeatable"
rerun_with = "R__seed_data"
---
*/
CREATE OR REPLACE VIEW v_users AS SELECT * FROM users;`);
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("scanProjectFiles", () => {
  test("classifies versioned files by naming convention", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    const v001 = result.files.find((f) => f.filename === "V001__add_email.sql");
    expect(v001).toBeDefined();
    expect(v001!.type).toBe("versioned");
    expect(v001!.version).toBe("001");
  });

  test("classifies versioned files by header", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    const v000 = result.files.find((f) => f.filename === "V000__schema.sql");
    expect(v000).toBeDefined();
    expect(v000!.type).toBe("versioned");
    expect(v000!.version).toBe("000");
  });

  test("classifies repeatable files by naming convention", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    const r = result.files.find((f) => f.filename === "R__seed_data.sql");
    expect(r).toBeDefined();
    expect(r!.type).toBe("repeatable");
    expect(r!.version).toBeUndefined();
  });

  test("classifies implicit routine files", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    const add = result.files.find((f) => f.filename === "add.sql");
    expect(add).toBeDefined();
    expect(add!.type).toBe("routine");
  });

  test("classifies explicit routine files", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    const sub = result.files.find((f) => f.filename === "subtract.sql");
    expect(sub).toBeDefined();
    expect(sub!.type).toBe("routine");
  });

  test("header overrides naming convention", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    const f = result.files.find((f) => f.filename === "R__actually_versioned.sql");
    expect(f).toBeDefined();
    expect(f!.type).toBe("versioned");
    expect(f!.version).toBe("099");
  });

  test("warns on contradictory header (version + repeatable)", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    const w = result.warnings.find((w) => w.file === "bad_contradictory.sql");
    expect(w).toBeDefined();
    expect(w!.message).toContain("Contradictory");
    expect(result.files.find((f) => f.filename === "bad_contradictory.sql")).toBeUndefined();
  });

  test("warns on explicit routine type with no valid routine", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    const w = result.warnings.find((w) => w.file === "bad_routine.sql");
    expect(w).toBeDefined();
    expect(w!.message).toContain("no valid routine");
    expect(result.files.find((f) => f.filename === "bad_routine.sql")).toBeUndefined();
  });

  test("warns on unrecognized files", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    const w = result.warnings.find((w) => w.file === "random_notes.sql");
    expect(w).toBeDefined();
    expect(w!.message).toContain("not recognized");
  });

  test("warns on versioned header without version", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    const w = result.warnings.find((w) => w.file === "bad_versioned.sql");
    expect(w).toBeDefined();
    expect(w!.message).toContain("no version found");
  });

  test("preserves header fields (run_before, rerun_with)", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    const mul = result.files.find((f) => f.filename === "multiply.sql");
    expect(mul).toBeDefined();
    expect(mul!.header).not.toBeNull();
    expect(mul!.header!.run_before).toBe("R__seed_data");
    expect(mul!.header!.rerun_with).toEqual(["R__seed_data"]);
  });

  test("normalizes rerun_with string to array", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    const views = result.files.find((f) => f.filename === "R__views.sql");
    expect(views).toBeDefined();
    expect(views!.header!.rerun_with).toEqual(["R__seed_data"]);
  });

  test("computes SHA-256 hash for each file", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    for (const f of result.files) {
      expect(f.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("sets relPath relative to project dir", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    const add = result.files.find((f) => f.filename === "add.sql");
    expect(add).toBeDefined();
    expect(add!.relPath).toBe("api/mathmodule/add.sql");
  });

  test("custom prefixes and separator", () => {
    // Create files with custom convention
    writeFile("UP_001-schema.sql", `CREATE TABLE test (id int);`);
    writeFile("REP-init.sql", `INSERT INTO test VALUES (1);`);

    const customOpts: ScanOptions = {
      upPrefix: "UP_",
      repeatablePrefix: "REP",
      separator: "-",
    };

    const result = scanProjectFiles(testDir, customOpts);
    const up = result.files.find((f) => f.filename === "UP_001-schema.sql");
    expect(up).toBeDefined();
    expect(up!.type).toBe("versioned");
    expect(up!.version).toBe("001");

    const rep = result.files.find((f) => f.filename === "REP-init.sql");
    expect(rep).toBeDefined();
    expect(rep!.type).toBe("repeatable");
  });

  test("detectRoutines = false skips routine parsing", () => {
    const result = scanProjectFiles(testDir, { ...defaultOpts, detectRoutines: false });
    // add.sql has no header and no naming convention — without routine detection it's unrecognized
    const add = result.files.find((f) => f.filename === "add.sql");
    expect(add).toBeUndefined();
    const w = result.warnings.find((w) => w.file === "api/mathmodule/add.sql");
    expect(w).toBeDefined();
  });

  test("total file count matches expected", () => {
    const result = scanProjectFiles(testDir, defaultOpts);
    // Valid files: V000, V001, R__seed_data, add, subtract, R__actually_versioned, multiply, R__views
    // + UP_001 and REP (from custom prefix test) — these won't match default opts
    // UP_001-schema.sql and REP-init.sql with default opts: unrecognized
    expect(result.files.length).toBe(8);
    // Warnings: bad_contradictory, bad_routine, random_notes, bad_versioned, UP_001, REP
    expect(result.warnings.length).toBe(6);
  });
});
