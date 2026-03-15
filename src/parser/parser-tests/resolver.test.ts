import { describe, test, expect } from "bun:test";
import { resolveExecutionPlan, type HistoryEntry } from "../resolver.ts";
import type { ProjectFile } from "../scanner.ts";

/** Helper to create a minimal ProjectFile for testing. */
function makeFile(overrides: Partial<ProjectFile> & { relPath: string; type: ProjectFile["type"] }): ProjectFile {
  const filename = overrides.relPath.split("/").pop()!;
  return {
    path: `/project/${overrides.relPath}`,
    relPath: overrides.relPath,
    filename: overrides.filename ?? filename,
    type: overrides.type,
    version: overrides.version,
    name: overrides.name ?? filename.replace(/\.sql$/i, "").replace(/[^a-zA-Z0-9]/g, " ").trim(),
    header: overrides.header ?? null,
    content: overrides.content ?? "SELECT 1;",
    hash: overrides.hash ?? `hash_${overrides.relPath}`,
  };
}

describe("resolveExecutionPlan", () => {
  describe("basic execution set", () => {
    test("new versioned file is included", () => {
      const files = [makeFile({ relPath: "V001__schema.sql", type: "versioned", version: "001" })];
      const result = resolveExecutionPlan(files, []);
      expect(result.files.length).toBe(1);
      expect(result.files[0].reason).toBe("new");
    });

    test("versioned file already in history is excluded", () => {
      const files = [makeFile({ relPath: "V001__schema.sql", type: "versioned", version: "001", name: "V001 schema" })];
      const history: HistoryEntry[] = [{ name: "V001 schema", type: "VERSIONED", version: "001", hash: "old" }];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(0);
    });

    test("new repeatable file is included", () => {
      const files = [makeFile({ relPath: "R__seed.sql", type: "repeatable", name: "R seed" })];
      const result = resolveExecutionPlan(files, []);
      expect(result.files.length).toBe(1);
      expect(result.files[0].reason).toBe("new");
    });

    test("repeatable file with same hash is excluded", () => {
      const files = [makeFile({ relPath: "R__seed.sql", type: "repeatable", name: "R seed", hash: "abc123" })];
      const history: HistoryEntry[] = [{ name: "R seed", type: "REPEATABLE", hash: "abc123" }];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(0);
    });

    test("repeatable file with changed hash is included", () => {
      const files = [makeFile({ relPath: "R__seed.sql", type: "repeatable", name: "R seed", hash: "new_hash" })];
      const history: HistoryEntry[] = [{ name: "R seed", type: "REPEATABLE", hash: "old_hash" }];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(1);
      expect(result.files[0].reason).toBe("changed");
    });

    test("new routine file is included", () => {
      const files = [makeFile({ relPath: "api/add.sql", type: "routine", name: "add" })];
      const result = resolveExecutionPlan(files, []);
      expect(result.files.length).toBe(1);
      expect(result.files[0].reason).toBe("new");
    });

    test("routine file with same hash is excluded", () => {
      const files = [makeFile({ relPath: "api/add.sql", type: "routine", name: "add", hash: "same" })];
      const history: HistoryEntry[] = [{ name: "add", type: "ROUTINE", hash: "same" }];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(0);
    });

    test("routine file with changed hash is included", () => {
      const files = [makeFile({ relPath: "api/add.sql", type: "routine", name: "add", hash: "new" })];
      const history: HistoryEntry[] = [{ name: "add", type: "ROUTINE", hash: "old" }];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(1);
      expect(result.files[0].reason).toBe("changed");
    });
  });

  describe("ordering", () => {
    test("versioned files come before repeatable and routine", () => {
      const files = [
        makeFile({ relPath: "api/add.sql", type: "routine", name: "add" }),
        makeFile({ relPath: "R__seed.sql", type: "repeatable", name: "R seed" }),
        makeFile({ relPath: "V001__schema.sql", type: "versioned", version: "001", name: "V001 schema" }),
      ];
      const result = resolveExecutionPlan(files, []);
      expect(result.files[0].type).toBe("versioned");
      expect(result.files[1].type).toBe("repeatable");
      expect(result.files[2].type).toBe("routine");
    });

    test("versioned files sorted by version numerically", () => {
      const files = [
        makeFile({ relPath: "V010__ten.sql", type: "versioned", version: "010", name: "V010 ten" }),
        makeFile({ relPath: "V002__two.sql", type: "versioned", version: "002", name: "V002 two" }),
        makeFile({ relPath: "V001__one.sql", type: "versioned", version: "001", name: "V001 one" }),
      ];
      const result = resolveExecutionPlan(files, []);
      expect(result.files.map((f) => f.version)).toEqual(["001", "002", "010"]);
    });

    test("repeatable and routine files sorted by name", () => {
      const files = [
        makeFile({ relPath: "api/subtract.sql", type: "routine", name: "subtract" }),
        makeFile({ relPath: "api/add.sql", type: "routine", name: "add" }),
        makeFile({ relPath: "R__zebra.sql", type: "repeatable", name: "R zebra" }),
        makeFile({ relPath: "R__alpha.sql", type: "repeatable", name: "R alpha" }),
      ];
      const result = resolveExecutionPlan(files, []);
      expect(result.files.map((f) => f.name)).toEqual(["R alpha", "R zebra", "add", "subtract"]);
    });
  });

  describe("run_before ordering", () => {
    test("run_before places file before its target", () => {
      const files = [
        makeFile({
          relPath: "R__types.sql",
          type: "repeatable",
          name: "R types",
          header: { run_before: "R__views.sql" },
        }),
        makeFile({ relPath: "R__views.sql", type: "repeatable", name: "R views" }),
      ];
      const result = resolveExecutionPlan(files, []);
      const names = result.files.map((f) => f.name);
      expect(names.indexOf("R types")).toBeLessThan(names.indexOf("R views"));
    });

    test("run_before with filename stem reference", () => {
      const files = [
        makeFile({
          relPath: "R__types.sql",
          type: "repeatable",
          name: "R types",
          header: { run_before: "R__views" },
        }),
        makeFile({ relPath: "R__views.sql", type: "repeatable", name: "R views" }),
      ];
      const result = resolveExecutionPlan(files, []);
      const names = result.files.map((f) => f.name);
      expect(names.indexOf("R types")).toBeLessThan(names.indexOf("R views"));
    });

    test("run_before target not in execution set is ignored", () => {
      const files = [
        makeFile({
          relPath: "R__types.sql",
          type: "repeatable",
          name: "R types",
          hash: "new",
          header: { run_before: "R__not_executing" },
        }),
      ];
      const history: HistoryEntry[] = [];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(1);
      expect(result.warnings.length).toBe(0);
    });

    test("circular run_before produces warning", () => {
      const files = [
        makeFile({
          relPath: "A.sql",
          type: "repeatable",
          name: "A",
          header: { run_before: "B.sql" },
        }),
        makeFile({
          relPath: "B.sql",
          type: "repeatable",
          name: "B",
          header: { run_before: "A.sql" },
        }),
      ];
      const result = resolveExecutionPlan(files, []);
      expect(result.files.length).toBe(2);
      expect(result.warnings.some((w) => w.message.includes("Circular"))).toBe(true);
    });
  });

  describe("rerun_with cascading", () => {
    test("file cascades when referenced file is executing", () => {
      const files = [
        makeFile({ relPath: "R__types.sql", type: "repeatable", name: "R types", hash: "changed" }),
        makeFile({
          relPath: "R__views.sql",
          type: "repeatable",
          name: "R views",
          hash: "same",
          header: { rerun_with: ["R__types.sql"] },
        }),
      ];
      const history: HistoryEntry[] = [
        { name: "R types", type: "REPEATABLE", hash: "old" },
        { name: "R views", type: "REPEATABLE", hash: "same" },
      ];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(2);
      const views = result.files.find((f) => f.name === "R views");
      expect(views).toBeDefined();
      expect(views!.reason).toBe("cascade");
    });

    test("file does not cascade when referenced file is NOT executing", () => {
      const files = [
        makeFile({ relPath: "R__types.sql", type: "repeatable", name: "R types", hash: "same" }),
        makeFile({
          relPath: "R__views.sql",
          type: "repeatable",
          name: "R views",
          hash: "same",
          header: { rerun_with: ["R__types.sql"] },
        }),
      ];
      const history: HistoryEntry[] = [
        { name: "R types", type: "REPEATABLE", hash: "same" },
        { name: "R views", type: "REPEATABLE", hash: "same" },
      ];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(0);
    });

    test("transitive cascade: A triggers B triggers C", () => {
      const files = [
        makeFile({ relPath: "A.sql", type: "repeatable", name: "A", hash: "changed" }),
        makeFile({
          relPath: "B.sql",
          type: "repeatable",
          name: "B",
          hash: "same",
          header: { rerun_with: ["A.sql"] },
        }),
        makeFile({
          relPath: "C.sql",
          type: "repeatable",
          name: "C",
          hash: "same",
          header: { rerun_with: ["B.sql"] },
        }),
      ];
      const history: HistoryEntry[] = [
        { name: "A", type: "REPEATABLE", hash: "old" },
        { name: "B", type: "REPEATABLE", hash: "same" },
        { name: "C", type: "REPEATABLE", hash: "same" },
      ];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(3);
      expect(result.files.find((f) => f.name === "B")!.reason).toBe("cascade");
      expect(result.files.find((f) => f.name === "C")!.reason).toBe("cascade");
    });

    test("rerun_with by filename stem", () => {
      const files = [
        makeFile({ relPath: "R__types.sql", type: "repeatable", name: "R types", hash: "changed" }),
        makeFile({
          relPath: "R__views.sql",
          type: "repeatable",
          name: "R views",
          hash: "same",
          header: { rerun_with: ["R__types"] },
        }),
      ];
      const history: HistoryEntry[] = [
        { name: "R types", type: "REPEATABLE", hash: "old" },
        { name: "R views", type: "REPEATABLE", hash: "same" },
      ];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(2);
    });

    test("rerun_with with multiple references — any match triggers", () => {
      const files = [
        makeFile({ relPath: "A.sql", type: "repeatable", name: "A", hash: "same" }),
        makeFile({ relPath: "B.sql", type: "repeatable", name: "B", hash: "changed" }),
        makeFile({
          relPath: "C.sql",
          type: "repeatable",
          name: "C",
          hash: "same",
          header: { rerun_with: ["A.sql", "B.sql"] },
        }),
      ];
      const history: HistoryEntry[] = [
        { name: "A", type: "REPEATABLE", hash: "same" },
        { name: "B", type: "REPEATABLE", hash: "old" },
        { name: "C", type: "REPEATABLE", hash: "same" },
      ];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(2); // B (changed) + C (cascade)
      expect(result.files.find((f) => f.name === "C")!.reason).toBe("cascade");
    });
  });

  describe("flexible file references", () => {
    test("rerun_with by bare name (stripped prefix)", () => {
      const files = [
        makeFile({ relPath: "V000__schema.sql", type: "versioned", version: "000", name: "V000 schema", hash: "changed" }),
        makeFile({
          relPath: "R__views.sql",
          type: "repeatable",
          name: "R views",
          hash: "same",
          header: { rerun_with: ["schema"] },
        }),
      ];
      const history: HistoryEntry[] = [
        { name: "V000 schema", type: "VERSIONED", version: "000", hash: "old" },
        { name: "R views", type: "REPEATABLE", hash: "same" },
      ];
      // V000 is versioned and already in history, so it won't re-run
      // But if it were new/changed, bare name should match
    });

    test("rerun_with by relative path with ./", () => {
      const files = [
        makeFile({ relPath: "R__types.sql", type: "repeatable", name: "R types", hash: "changed" }),
        makeFile({
          relPath: "R__views.sql",
          type: "repeatable",
          name: "R views",
          hash: "same",
          header: { rerun_with: ["./R__types.sql"] },
        }),
      ];
      const history: HistoryEntry[] = [
        { name: "R types", type: "REPEATABLE", hash: "old" },
        { name: "R views", type: "REPEATABLE", hash: "same" },
      ];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(2);
      expect(result.files.find((f) => f.name === "R views")!.reason).toBe("cascade");
    });

    test("rerun_with by relative path with /", () => {
      const files = [
        makeFile({ relPath: "R__types.sql", type: "repeatable", name: "R types", hash: "changed" }),
        makeFile({
          relPath: "R__views.sql",
          type: "repeatable",
          name: "R views",
          hash: "same",
          header: { rerun_with: ["/R__types.sql"] },
        }),
      ];
      const history: HistoryEntry[] = [
        { name: "R types", type: "REPEATABLE", hash: "old" },
        { name: "R views", type: "REPEATABLE", hash: "same" },
      ];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(2);
    });

    test("run_before by version number", () => {
      const files = [
        makeFile({
          relPath: "R__types.sql",
          type: "repeatable",
          name: "R types",
          header: { run_before: "001" },
        }),
        makeFile({ relPath: "V001__schema.sql", type: "versioned", version: "001", name: "V001 schema" }),
      ];
      const result = resolveExecutionPlan(files, []);
      const names = result.files.map((f) => f.name);
      expect(names.indexOf("R types")).toBeLessThan(names.indexOf("V001 schema"));
    });

    test("run_before by bare name", () => {
      const files = [
        makeFile({
          relPath: "R__types.sql",
          type: "repeatable",
          name: "R types",
          header: { run_before: "views" },
        }),
        makeFile({ relPath: "R__views.sql", type: "repeatable", name: "R views" }),
      ];
      const result = resolveExecutionPlan(files, []);
      const names = result.files.map((f) => f.name);
      expect(names.indexOf("R types")).toBeLessThan(names.indexOf("R views"));
    });

    test("rerun_with by version number for versioned files", () => {
      const files = [
        makeFile({ relPath: "V002__add_col.sql", type: "versioned", version: "002", name: "V002 add col" }),
        makeFile({
          relPath: "R__views.sql",
          type: "repeatable",
          name: "R views",
          hash: "same",
          header: { rerun_with: ["002"] },
        }),
      ];
      const history: HistoryEntry[] = [
        { name: "R views", type: "REPEATABLE", hash: "same" },
      ];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(2);
      expect(result.files.find((f) => f.name === "R views")!.reason).toBe("cascade");
    });
  });

  describe("combined scenarios", () => {
    test("full scenario: versioned + repeatable + routine + cascade + ordering", () => {
      const files = [
        makeFile({ relPath: "V001__init.sql", type: "versioned", version: "001", name: "V001 init" }),
        makeFile({ relPath: "V002__tables.sql", type: "versioned", version: "002", name: "V002 tables" }),
        makeFile({
          relPath: "R__types.sql",
          type: "repeatable",
          name: "R types",
          hash: "changed",
          header: { run_before: "R__views.sql" },
        }),
        makeFile({
          relPath: "R__views.sql",
          type: "repeatable",
          name: "R views",
          hash: "same",
          header: { rerun_with: ["R__types.sql"] },
        }),
        makeFile({ relPath: "api/add.sql", type: "routine", name: "add", hash: "same" }),
      ];
      const history: HistoryEntry[] = [
        { name: "V001 init", type: "VERSIONED", version: "001", hash: "x" },
        { name: "R types", type: "REPEATABLE", hash: "old" },
        { name: "R views", type: "REPEATABLE", hash: "same" },
        { name: "add", type: "ROUTINE", hash: "same" },
      ];

      const result = resolveExecutionPlan(files, history);

      // V001 already executed, V002 is new
      // R__types changed, R__views cascades
      // add is unchanged
      expect(result.files.length).toBe(3);

      const names = result.files.map((f) => f.name);
      expect(names).toContain("V002 tables");
      expect(names).toContain("R types");
      expect(names).toContain("R views");

      // V002 must come first (versioned before repeatable)
      expect(names[0]).toBe("V002 tables");
      // R types must come before R views (run_before)
      expect(names.indexOf("R types")).toBeLessThan(names.indexOf("R views"));
    });

    test("empty history — all files execute", () => {
      const files = [
        makeFile({ relPath: "V001__init.sql", type: "versioned", version: "001", name: "V001 init" }),
        makeFile({ relPath: "R__seed.sql", type: "repeatable", name: "R seed" }),
        makeFile({ relPath: "api/add.sql", type: "routine", name: "add" }),
      ];
      const result = resolveExecutionPlan(files, []);
      expect(result.files.length).toBe(3);
    });

    test("all files up to date — nothing executes", () => {
      const files = [
        makeFile({ relPath: "V001__init.sql", type: "versioned", version: "001", name: "V001 init", hash: "h1" }),
        makeFile({ relPath: "R__seed.sql", type: "repeatable", name: "R seed", hash: "h2" }),
      ];
      const history: HistoryEntry[] = [
        { name: "V001 init", type: "VERSIONED", version: "001", hash: "h1" },
        { name: "R seed", type: "REPEATABLE", hash: "h2" },
      ];
      const result = resolveExecutionPlan(files, history);
      expect(result.files.length).toBe(0);
    });
  });
});
