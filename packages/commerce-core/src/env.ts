import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scrubSecrets } from "@astro/db";

/**
 * Minimal .env loader (no dependency). Loads, in order: .env, config/private.env.
 * Existing process.env values always win. Values are never logged.
 */
export function loadEnv(rootDir = process.cwd()): string[] {
  const loaded: string[] = [];
  for (const rel of [".env", "config/private.env"]) {
    const p = resolve(rootDir, rel);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      // `KEY=   # comment` means empty; `KEY=value # comment` means value. Quoted values keep their #.
      if (value.startsWith("#")) value = "";
      const hash = value.indexOf(" #");
      if (hash > 0 && !value.startsWith('"') && !value.startsWith("'")) value = value.slice(0, hash).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
        loaded.push(key);
      }
    }
  }
  return loaded;
}

export function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export function hasEnv(name: string): boolean {
  return env(name) !== "";
}

/** Redact anything that looks like a secret before logging (same implementation the DB sinks use). */
export function redact(input: unknown): string {
  return scrubSecrets(input);
}
