/**
 * Load `.dev.vars` (KEY=value lines) into process.env without overriding real
 * environment variables. Node/bun entrypoint helper only — never imported
 * from code that runs on Workers.
 * @module
 */
import { readFileSync } from "node:fs";

export function loadDevVars(path = ".dev.vars"): void {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No .dev.vars — run from the real environment.
  }
}
