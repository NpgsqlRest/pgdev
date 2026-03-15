/**
 * Resolve which project files need execution and in what order.
 *
 * 1. Compare scanned files against history to determine what needs executing
 * 2. Apply rerun_with cascading (if a referenced file runs, cascade to dependents)
 * 3. Apply run_before ordering (topological sort)
 */

import type { ProjectFile, FileType } from "./scanner.ts";

export interface HistoryEntry {
  name: string;
  type: string; // "VERSIONED" | "REPEATABLE" | "ROUTINE"
  version?: string;
  hash: string;
}

export interface ResolvedFile extends ProjectFile {
  /** Reason this file was included in the execution set */
  reason: "new" | "changed" | "cascade";
}

export interface ResolveResult {
  /** Files to execute, in order */
  files: ResolvedFile[];
  /** Warnings from resolution */
  warnings: { file: string; message: string }[];
}

/**
 * Normalize FileType to history type string.
 */
function toHistoryType(type: FileType): string {
  return type.toUpperCase();
}

/**
 * Match a project file to a history entry.
 */
function findHistoryEntry(file: ProjectFile, history: HistoryEntry[]): HistoryEntry | undefined {
  const histType = toHistoryType(file.type);
  return history.find((h) => h.name === file.name && h.type === histType);
}

/**
 * Determine which files need execution based on history.
 */
function computeExecutionSet(
  files: ProjectFile[],
  history: HistoryEntry[],
): Map<string, { file: ProjectFile; reason: "new" | "changed" }> {
  const needsExec = new Map<string, { file: ProjectFile; reason: "new" | "changed" }>();

  for (const file of files) {
    const entry = findHistoryEntry(file, history);

    if (file.type === "versioned") {
      // Versioned: execute if version not in history
      if (!entry) {
        needsExec.set(file.relPath, { file, reason: "new" });
      }
    } else {
      // Repeatable / routine: execute if hash changed or new
      if (!entry) {
        needsExec.set(file.relPath, { file, reason: "new" });
      } else if (entry.hash !== file.hash) {
        needsExec.set(file.relPath, { file, reason: "changed" });
      }
    }
  }

  return needsExec;
}

/**
 * Build a lookup map from various reference formats to relPath.
 *
 * Supported reference forms:
 * - relPath: "test/V000_schema.sql"
 * - relPath with leading ./ or /: "./test/V000_schema.sql", "/test/V000_schema.sql"
 * - filename with extension: "V000_schema.sql"
 * - filename without extension: "V000_schema"
 * - bare name (stripped of prefixes and extensions): "schema"
 * - version number for versioned files: "000"
 */
function buildRefIndex(files: ProjectFile[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const f of files) {
    // relPath as-is
    index.set(f.relPath, f.relPath);
    // relPath with leading ./ or /
    index.set(`./${f.relPath}`, f.relPath);
    index.set(`/${f.relPath}`, f.relPath);
    // filename with extension
    index.set(f.filename, f.relPath);
    // filename without extension
    const stem = f.filename.replace(/\.sql$/i, "");
    index.set(stem, f.relPath);
    // bare name: strip prefix + separator from stem
    // e.g. V000__schema → schema, R__seed_data → seed_data
    const sepIdx = stem.indexOf("__");
    if (sepIdx !== -1) {
      const bareName = stem.slice(sepIdx + 2);
      if (bareName) {
        // Only set if not already taken (first wins to avoid conflicts)
        if (!index.has(bareName)) {
          index.set(bareName, f.relPath);
        }
      }
    }
    // version number for versioned files
    if (f.type === "versioned" && f.version) {
      if (!index.has(f.version)) {
        index.set(f.version, f.relPath);
      }
    }
  }
  return index;
}

/**
 * Apply rerun_with cascading: if any referenced file is in the execution set,
 * add this file too.
 */
function applyCascade(
  files: ProjectFile[],
  needsExec: Map<string, { file: ProjectFile; reason: "new" | "changed" | "cascade" }>,
): void {
  const relPathByRef = buildRefIndex(files);

  // Iterate until no more cascades (handles transitive chains)
  let changed = true;
  while (changed) {
    changed = false;
    for (const file of files) {
      if (needsExec.has(file.relPath)) continue;
      const rerunWith = file.header?.rerun_with;
      if (!rerunWith || rerunWith.length === 0) continue;

      for (const ref of rerunWith) {
        const resolvedRef = relPathByRef.get(ref);
        if (resolvedRef && needsExec.has(resolvedRef)) {
          needsExec.set(file.relPath, { file, reason: "cascade" });
          changed = true;
          break;
        }
      }
    }
  }
}

/**
 * Apply run_before ordering via topological sort.
 * Returns ordered files or adds warnings for cycles.
 */
function applyOrdering(
  execFiles: ResolvedFile[],
  allFiles: ProjectFile[],
): { ordered: ResolvedFile[]; warnings: { file: string; message: string }[] } {
  const warnings: { file: string; message: string }[] = [];

  // Build lookup: various reference forms → index in execFiles
  const refToRelPath = buildRefIndex(execFiles);
  const relPathToIdx = new Map<string, number>();
  for (let i = 0; i < execFiles.length; i++) {
    relPathToIdx.set(execFiles[i].relPath, i);
  }

  // Build adjacency: edges[i] = set of indices that must come after i
  const n = execFiles.length;
  const edges: Set<number>[] = Array.from({ length: n }, () => new Set());
  const inDegree = new Array(n).fill(0);

  for (let i = 0; i < execFiles.length; i++) {
    const runBefore = execFiles[i].header?.run_before;
    if (!runBefore) continue;

    const targetRelPath = refToRelPath.get(runBefore);
    const targetIdx = targetRelPath !== undefined ? relPathToIdx.get(targetRelPath) : undefined;
    if (targetIdx !== undefined && targetIdx !== i) {
      // i must run before targetIdx
      if (!edges[i].has(targetIdx)) {
        edges[i].add(targetIdx);
        inDegree[targetIdx]++;
      }
    }
    // If target not in execution set, ignore silently
  }

  // Kahn's algorithm for topological sort
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }

  const ordered: ResolvedFile[] = [];
  while (queue.length > 0) {
    // Among nodes with 0 in-degree, pick the one with the lowest natural order
    // (preserves stable sorting when no constraints exist)
    queue.sort((a, b) => a - b);
    const idx = queue.shift()!;
    ordered.push(execFiles[idx]);
    for (const neighbor of edges[idx]) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) queue.push(neighbor);
    }
  }

  if (ordered.length < n) {
    // Cycle detected — add remaining files with warning
    for (let i = 0; i < n; i++) {
      if (!ordered.includes(execFiles[i])) {
        warnings.push({
          file: execFiles[i].relPath,
          message: "Circular run_before dependency detected. Added in natural order.",
        });
        ordered.push(execFiles[i]);
      }
    }
  }

  return { ordered, warnings };
}

/**
 * Resolve which files need execution and in what order.
 */
export function resolveExecutionPlan(
  files: ProjectFile[],
  history: HistoryEntry[],
): ResolveResult {
  // Step 1: Determine base execution set
  const needsExec = computeExecutionSet(files, history);

  // Step 2: Apply rerun_with cascading
  applyCascade(files, needsExec);

  // Step 3: Sort by type priority + natural order before applying run_before
  const execFiles: ResolvedFile[] = [...needsExec.values()].map(({ file, reason }) => ({
    ...file,
    reason,
  }));

  // Sort: versioned first (by version), then repeatable/routine (by name)
  execFiles.sort((a, b) => {
    const typeOrder = { versioned: 0, repeatable: 1, routine: 2 };
    const ta = typeOrder[a.type];
    const tb = typeOrder[b.type];
    if (ta !== tb) return ta - tb;
    if (a.type === "versioned" && b.type === "versioned") {
      return (a.version ?? "").localeCompare(b.version ?? "", undefined, { numeric: true });
    }
    return a.name.localeCompare(b.name);
  });

  // Step 4: Apply run_before topological ordering
  const { ordered, warnings } = applyOrdering(execFiles, files);

  return { files: ordered, warnings };
}
