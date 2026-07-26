import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load KEY=VALUE pairs from a .env file into process.env
 * without overriding variables already set in the environment.
 * Missing file is a no-op (safe for CI / fresh clones).
 */
export function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, 'utf-8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/**
 * Resolve .env locations for the end-to-end sync CLI:
 * 1) process.cwd()/.env  (when you run from repo root or ts-src)
 * 2) package root /.env and ../.env (repo root when bin lives in ts-src/dist)
 */
export function loadSyncEnv(): void {
  const candidates = new Set<string>();
  candidates.add(resolve(process.cwd(), '.env'));

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // ts-src/src/util → repo root is ../../..
    // ts-src/dist/util → repo root is ../../..
    candidates.add(resolve(here, '../../../.env'));
    candidates.add(resolve(here, '../../.env'));
  } catch {
    /* ignore */
  }

  for (const file of candidates) {
    loadEnvFile(file);
  }
}
