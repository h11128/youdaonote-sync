import type Database from 'better-sqlite3';

/**
 * sync_state table (key-value). Single responsibility: key-value sync state.
 */
export function getState(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function getStateInt(db: Database.Database, key: string, defaultValue = 0): number {
  const val = getState(db, key);
  if (val === null) return defaultValue;
  const n = parseInt(val, 10);
  return isNaN(n) ? defaultValue : n;
}
