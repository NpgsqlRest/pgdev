import { resolve } from "node:path";
import { readdirSync } from "node:fs";

/** Recursively find all .sql files in a directory. */
export function findSqlFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSqlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".sql")) {
      results.push(full);
    }
  }
  return results.sort();
}
