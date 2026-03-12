import { resolve } from "node:path";

/** Replace `{key}` placeholders in a string using values from a dictionary. */
export function resolvePlaceholders(
  value: string,
  dict: Record<string, string>,
): { resolved: string; unresolved: string[] } {
  if (!value.includes("{")) return { resolved: value, unresolved: [] };
  const unresolved: string[] = [];
  const resolved = value.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    if (key in dict) return dict[key];
    unresolved.push(key);
    return `{${key}}`;
  });
  return { resolved, unresolved };
}

/** @deprecated Use `resolvePlaceholders` instead. */
export const resolveEnvVars = resolvePlaceholders;

export async function loadEnvFile(path: string): Promise<Record<string, string>> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};

  const vars: Record<string, string> = {};
  const text = await file.text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

export async function buildPgdevEnvDict(envFile?: string): Promise<Record<string, string>> {
  const envDict: Record<string, string> = {};

  // System environment
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) envDict[key] = value;
  }

  // Env file (overrides system env)
  if (envFile) {
    const envFilePath = resolve(process.cwd(), envFile);
    const fileVars = await loadEnvFile(envFilePath);
    Object.assign(envDict, fileVars);
  }

  return envDict;
}
