import { resolve } from "node:path";

export function resolveEnvVars(
  value: string,
  envDict: Record<string, string>,
): { resolved: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const resolved = value.replace(/\{([^}]+)\}/g, (_match, varName: string) => {
    if (varName in envDict) return envDict[varName];
    unresolved.push(varName);
    return `{${varName}}`;
  });
  return { resolved, unresolved };
}

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
