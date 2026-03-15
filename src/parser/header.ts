/**
 * Parse pgdev TOML headers from SQL files.
 *
 * Supports two formats at the top of file:
 *
 * Format 1 — line comments:
 *   -- [pgdev]
 *   -- type = "routine"
 *   -- run_before = "R__create_views"
 *
 * Format 2 — block comment with --- delimiters:
 *   /*
 *   ---
 *   [pgdev]
 *   type = "routine"
 *   ---
 *   *​/
 */

export interface PgdevHeader {
  type?: "routine" | "repeatable" | "versioned";
  version?: string;
  run_before?: string;
  rerun_with?: string[];
}

/**
 * Parse the pgdev TOML header from the top of a SQL file.
 * Returns null if no header is found.
 */
export function parsePgdevHeader(content: string): PgdevHeader | null {
  const trimmed = content.trimStart();

  // Try Format 2 first (block comment with --- delimiters)
  const format2 = parseFormat2(trimmed);
  if (format2 !== null) return format2;

  // Try Format 1 (line comments)
  const format1 = parseFormat1(trimmed);
  if (format1 !== null) return format1;

  return null;
}

/**
 * Format 1: line comments starting with -- [pgdev]
 *
 *   -- [pgdev]
 *   -- key = "value"
 *   -- key2 = "value2"
 */
function parseFormat1(content: string): PgdevHeader | null {
  const lines = content.split("\n");

  // Find -- [pgdev] line at the top (allow leading blank lines/comments)
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (!stripped || (stripped.startsWith("--") && !stripped.includes("[pgdev]"))) continue;
    if (/^--\s*\[pgdev\]\s*$/.test(stripped)) {
      startIdx = i;
      break;
    }
    break; // non-comment, non-blank line — stop looking
  }

  if (startIdx === -1) return null;

  // Collect subsequent -- lines as TOML content
  const tomlLines: string[] = ["[pgdev]"];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped.startsWith("--")) {
      // Remove the -- prefix and optional leading space
      const tomlLine = stripped.replace(/^--\s?/, "");
      tomlLines.push(tomlLine);
    } else {
      break;
    }
  }

  return parseTomlBlock(tomlLines.join("\n"));
}

/**
 * Format 2: block comment with --- delimiters
 *
 *   /*
 *   ---
 *   [pgdev]
 *   key = "value"
 *   ---
 *   *​/
 *
 * Or with content before the --- delimiter:
 *   /*
 *   regular comment
 *   ---
 *   [pgdev]
 *   key = "value"
 *   ---
 *   *​/
 */
function parseFormat2(content: string): PgdevHeader | null {
  // Must start with /* (allowing whitespace)
  if (!content.startsWith("/*")) return null;

  // Find the closing */
  const closeIdx = content.indexOf("*/");
  if (closeIdx === -1) return null;

  const block = content.slice(2, closeIdx);
  const lines = block.split("\n").map((l) => l.trim());

  // Find --- delimited section containing [pgdev]
  let sectionStart = -1;
  let sectionEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "---") {
      if (sectionStart === -1) {
        sectionStart = i;
      } else {
        sectionEnd = i;
        break;
      }
    }
  }

  if (sectionStart === -1 || sectionEnd === -1) return null;

  const sectionLines = lines.slice(sectionStart + 1, sectionEnd);
  const sectionText = sectionLines.join("\n");

  // Must contain [pgdev]
  if (!sectionText.includes("[pgdev]")) return null;

  return parseTomlBlock(sectionText);
}

/**
 * Parse a TOML block and extract pgdev header fields.
 */
function parseTomlBlock(toml: string): PgdevHeader | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(toml) as Record<string, unknown>;
  } catch {
    return null;
  }

  const pgdev = parsed.pgdev as Record<string, unknown> | undefined;
  if (!pgdev) return null;

  const header: PgdevHeader = {};

  if (typeof pgdev.type === "string") {
    if (pgdev.type === "routine" || pgdev.type === "repeatable" || pgdev.type === "versioned") {
      header.type = pgdev.type;
    }
  }

  if (typeof pgdev.version === "string" && pgdev.version !== "") {
    header.version = pgdev.version;
  }

  if (typeof pgdev.run_before === "string" && pgdev.run_before !== "") {
    header.run_before = pgdev.run_before;
  }

  if (pgdev.rerun_with != null) {
    if (typeof pgdev.rerun_with === "string") {
      header.rerun_with = pgdev.rerun_with ? [pgdev.rerun_with] : [];
    } else if (Array.isArray(pgdev.rerun_with)) {
      header.rerun_with = pgdev.rerun_with.filter((v): v is string => typeof v === "string" && v !== "");
    }
  }

  // Return null if nothing was actually parsed
  if (header.type === undefined && header.version === undefined &&
      header.run_before === undefined && header.rerun_with === undefined) {
    return null;
  }

  return header;
}

/**
 * Strip the pgdev header block from file content, returning only the SQL.
 * Handles both Format 1 (line comments) and Format 2 (block comment with --- delimiters).
 */
export function stripPgdevHeader(content: string): string {
  const trimmed = content.trimStart();
  const leadingWs = content.length - trimmed.length;

  // Format 2: block comment with --- and [pgdev]
  if (trimmed.startsWith("/*")) {
    const closeIdx = trimmed.indexOf("*/");
    if (closeIdx !== -1) {
      const block = trimmed.slice(2, closeIdx);
      const lines = block.split("\n").map((l) => l.trim());
      // Check if this block contains --- delimited [pgdev] section
      let hasPgdev = false;
      let inSection = false;
      for (const line of lines) {
        if (line === "---") {
          inSection = !inSection;
          continue;
        }
        if (inSection && line === "[pgdev]") {
          hasPgdev = true;
          break;
        }
      }
      if (hasPgdev) {
        // Strip the entire block comment (including */ and trailing newline)
        const afterClose = closeIdx + 2;
        let rest = trimmed.slice(afterClose);
        // Remove leading newline after */
        if (rest.startsWith("\n")) rest = rest.slice(1);
        return rest;
      }
    }
  }

  // Format 1: -- [pgdev] line comments
  const lines = trimmed.split("\n");
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (!stripped || (stripped.startsWith("--") && !stripped.includes("[pgdev]"))) continue;
    if (/^--\s*\[pgdev\]\s*$/.test(stripped)) {
      startIdx = i;
      break;
    }
    break;
  }

  if (startIdx === -1) return content;

  // Find end of -- comment block
  let endIdx = startIdx + 1;
  for (; endIdx < lines.length; endIdx++) {
    if (!lines[endIdx].trim().startsWith("--")) break;
  }

  const remaining = lines.slice(endIdx).join("\n");
  return remaining.startsWith("\n") ? remaining.slice(1) : remaining;
}
