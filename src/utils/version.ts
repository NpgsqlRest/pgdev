import { PACKAGE_NAME, NPM_REGISTRY_URL } from "../constants.ts";

export function getCurrentVersion(): string {
  // Read from the package.json that was installed
  const pkg = require("../../package.json");
  return pkg.version;
}

export async function getLatestVersion(): Promise<string> {
  const response = await fetch(`${NPM_REGISTRY_URL}/${PACKAGE_NAME}/latest`);
  if (!response.ok) {
    throw new Error(`Failed to fetch latest version: ${response.statusText}`);
  }
  const data = (await response.json()) as { version: string };
  return data.version;
}

/**
 * Returns true if latest is newer than current.
 * Simple semver comparison (major.minor.patch).
 */
export function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [cMajor, cMinor, cPatch] = parse(current);
  const [lMajor, lMinor, lPatch] = parse(latest);

  if (lMajor !== cMajor) return lMajor > cMajor;
  if (lMinor !== cMinor) return lMinor > cMinor;
  return lPatch > cPatch;
}
