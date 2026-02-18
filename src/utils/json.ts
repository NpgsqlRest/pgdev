/**
 * Utilities for reading and writing NpgsqlRest JSONC config files.
 * These files have // comment headers before the JSON body.
 */

/**
 * Separate the // comment header from the JSON body.
 * Header = all leading lines that are empty or start with //.
 */
export function splitHeaderAndJson(text: string): { header: string; json: string } {
  const lines = text.split("\n");
  let headerEnd = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("//")) {
      headerEnd = i + 1;
    } else {
      break;
    }
  }

  const header = lines.slice(0, headerEnd).join("\n");
  const json = lines.slice(headerEnd).join("\n");
  return { header: header ? header + "\n" : "", json };
}

/**
 * Strip // and block comments from JSON text (respects string literals).
 */
export function stripJsonComments(text: string): string {
  let result = "";
  let i = 0;
  const len = text.length;

  while (i < len) {
    // String literal
    if (text[i] === '"') {
      result += '"';
      i++;
      while (i < len && text[i] !== '"') {
        if (text[i] === "\\") {
          result += text[i] + (text[i + 1] ?? "");
          i += 2;
        } else {
          result += text[i];
          i++;
        }
      }
      if (i < len) {
        result += '"';
        i++;
      }
      continue;
    }

    // Line comment
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < len && text[i] !== "\n") i++;
      continue;
    }

    // Block comment
    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < len && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    result += text[i];
    i++;
  }

  return result;
}

/**
 * Read a JSONC config file. Returns parsed data and the original header,
 * or null if the file doesn't exist.
 */
export async function readJsonConfig(
  path: string,
): Promise<{ data: Record<string, unknown>; header: string } | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  const text = await file.text();
  const { header, json } = splitHeaderAndJson(text);
  const clean = stripJsonComments(json);
  const data = JSON.parse(clean) as Record<string, unknown>;
  return { data, header };
}

/**
 * Serialize a JSON value to JSONC with // comments above keys that have descriptions.
 * Comments use the NpgsqlRest convention: // wrapped above and below the description text.
 */
function serializeValue(
  value: unknown,
  descriptions: Record<string, string>,
  depth: number,
  path: string,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const pad = "  ".repeat(depth + 1);
    const outer = "  ".repeat(depth);
    const items = value.map((v) =>
      `${pad}${serializeValue(v, descriptions, depth + 1, path)}`,
    );
    return `[\n${items.join(",\n")}\n${outer}]`;
  }

  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";

    const pad = "  ".repeat(depth + 1);
    const outer = "  ".repeat(depth);
    const lines: string[] = [];

    for (let i = 0; i < entries.length; i++) {
      const [key, val] = entries[i];
      const keyPath = path ? `${path}.${key}` : key;
      const desc = descriptions[keyPath];
      const comma = i < entries.length - 1 ? "," : "";

      if (desc) {
        lines.push(`${pad}//`);
        for (const line of desc.split("\n")) {
          lines.push(`${pad}// ${line}`);
        }
        lines.push(`${pad}//`);
      }

      const valStr = serializeValue(val, descriptions, depth + 1, keyPath);
      lines.push(`${pad}${JSON.stringify(key)}: ${valStr}${comma}`);
    }

    return `{\n${lines.join("\n")}\n${outer}}`;
  }

  return JSON.stringify(value);
}

export function serializeJsonc(
  data: Record<string, unknown>,
  descriptions: Record<string, string>,
): string {
  return serializeValue(data, descriptions, 0, "") + "\n";
}

/**
 * Write a JSON config file, prepending the original comment header.
 * If descriptions are provided, writes JSONC with inline // comments.
 * Pretty-prints with 2-space indentation.
 */
export async function writeJsonConfig(
  path: string,
  data: Record<string, unknown>,
  header: string,
  descriptions?: Record<string, string>,
): Promise<void> {
  const body = descriptions
    ? serializeJsonc(data, descriptions)
    : JSON.stringify(data, null, 2) + "\n";
  await Bun.write(path, header + body);
}
