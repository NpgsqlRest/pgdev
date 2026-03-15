/**
 * Scan project_dir and classify SQL files as routine, versioned, or repeatable.
 */

import { resolve } from "node:path";
import { findSqlFiles } from "../utils/files.ts";
import { parsePgdevHeader, type PgdevHeader } from "./header.ts";
import { parseRoutines } from "./routine.ts";

export type FileType = "routine" | "versioned" | "repeatable";

export interface ProjectFile {
  /** Absolute path */
  path: string;
  /** Path relative to project_dir */
  relPath: string;
  /** Filename without directory */
  filename: string;
  /** Classified type */
  type: FileType;
  /** Version string (for versioned files) */
  version?: string;
  /** Migration name derived from filename */
  name: string;
  /** Parsed pgdev header, if present */
  header: PgdevHeader | null;
  /** File content */
  content: string;
  /** Content hash (SHA-256) */
  hash: string;
}

export interface ScanWarning {
  file: string;
  message: string;
}

export interface ScanResult {
  files: ProjectFile[];
  warnings: ScanWarning[];
}

export interface ScanOptions {
  upPrefix: string;
  repeatablePrefix: string;
  separator: string;
  /** Whether to parse routines for implicit detection (default: true) */
  detectRoutines?: boolean;
}

/**
 * Derive a human-readable migration name from a filename.
 * Strips the extension and replaces non-alphanumeric chars with spaces.
 */
function deriveName(filename: string): string {
  return filename.replace(/\.sql$/i, "").replace(/[^a-zA-Z0-9]/g, " ").trim().replace(/\s+/g, " ");
}

/**
 * Compute SHA-256 hash of content.
 */
function sha256(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

/**
 * Try to classify a file by its filename prefix (naming convention).
 * Returns the type and version (if versioned), or null if no convention matches.
 */
function classifyByPrefix(
  filename: string,
  opts: ScanOptions,
): { type: FileType; version?: string } | null {
  const { upPrefix, repeatablePrefix, separator } = opts;

  // Check versioned: V<version>__<name>.sql
  if (filename.startsWith(upPrefix)) {
    const sepIdx = filename.indexOf(separator, upPrefix.length);
    if (sepIdx !== -1) {
      const version = filename.slice(upPrefix.length, sepIdx);
      if (version.length > 0) {
        return { type: "versioned", version };
      }
    }
  }

  // Check repeatable: R__<name>.sql
  if (filename.startsWith(repeatablePrefix)) {
    const sepIdx = filename.indexOf(separator, repeatablePrefix.length);
    if (sepIdx !== -1) {
      return { type: "repeatable" };
    }
  }

  return null;
}

/**
 * Scan project_dir and classify all SQL files.
 */
export function scanProjectFiles(
  projectDir: string,
  opts: ScanOptions,
): ScanResult {
  const fullDir = resolve(projectDir);
  const sqlFiles = findSqlFiles(fullDir);
  const files: ProjectFile[] = [];
  const warnings: ScanWarning[] = [];
  const detectRoutines = opts.detectRoutines !== false;

  for (const filePath of sqlFiles) {
    const relPath = filePath.slice(fullDir.length + 1);
    const filename = filePath.split("/").pop()!;
    const content = require("node:fs").readFileSync(filePath, "utf-8") as string;
    const hash = sha256(content);
    const header = parsePgdevHeader(content);

    let type: FileType | null = null;
    let version: string | undefined;

    // Priority 1: Check for contradictory header (version + type = "repeatable")
    if (header?.version && header?.type === "repeatable") {
      warnings.push({
        file: relPath,
        message: `Contradictory header: version "${header.version}" with type "repeatable". Skipping.`,
      });
      continue;
    }

    // Priority 2: Explicit type = "routine" but no valid routine
    if (header?.type === "routine") {
      if (detectRoutines) {
        const routines = parseRoutines(content);
        if (routines.length === 0) {
          warnings.push({
            file: relPath,
            message: `Header declares type "routine" but no valid routine found. Skipping.`,
          });
          continue;
        }
      }
      type = "routine";
    }

    // Priority 3: Explicit type from header
    if (type === null && header?.version) {
      type = "versioned";
      version = header.version;
    }
    if (type === null && header?.type === "repeatable") {
      type = "repeatable";
    }
    if (type === null && header?.type === "versioned") {
      // versioned without version in header — check filename
      const prefixResult = classifyByPrefix(filename, opts);
      if (prefixResult?.type === "versioned") {
        type = "versioned";
        version = prefixResult.version;
      } else {
        warnings.push({
          file: relPath,
          message: `Header declares type "versioned" but no version found. Skipping.`,
        });
        continue;
      }
    }

    // Priority 4: Naming convention
    if (type === null) {
      const prefixResult = classifyByPrefix(filename, opts);
      if (prefixResult) {
        type = prefixResult.type;
        version = prefixResult.version;
      }
    }

    // Priority 5: Implicit routine detection
    if (type === null && detectRoutines) {
      const routines = parseRoutines(content);
      if (routines.length > 0) {
        type = "routine";
      }
    }

    // Priority 6: Unrecognized
    if (type === null) {
      warnings.push({
        file: relPath,
        message: `File type not recognized. Skipping.`,
      });
      continue;
    }

    const name = deriveName(filename);

    files.push({
      path: filePath,
      relPath,
      filename,
      type,
      version,
      name,
      header,
      content,
      hash,
    });
  }

  return { files, warnings };
}
