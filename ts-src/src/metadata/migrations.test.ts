import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initSchema,
  runMigrations,
  normalizeStoredPaths,
  normalizeStoredChars,
  runAllMigrations,
} from './migrations.js';
import type { StateAccessor } from './migrations.js';

const TMP = join(tmpdir(), `migrations-test-${Date.now()}`);
let db: Database.Database;

function makeAccessor(): StateAccessor {
  db.exec('CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return {
    getState(key: string): string | null {
      const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },
    setState(key: string, value: string): void {
      db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)').run(key, value);
    },
  };
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  db = new Database(join(TMP, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe('initSchema', () => {
  it('creates files and directories tables', () => {
    initSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toContain('files');
    expect(tables).toContain('directories');
  });

  it('is idempotent', () => {
    initSchema(db);
    initSchema(db);

    const count = db.prepare('SELECT count(*) as c FROM files').get() as { c: number };
    expect(count.c).toBe(0);
  });
});

describe('runMigrations', () => {
  it('applies all migrations on fresh db', () => {
    initSchema(db);
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toContain('sync_log');
    expect(tables).toContain('file_refs');
    expect(tables).toContain('file_base');
    expect(tables).toContain('sync_state');
    expect(tables).toContain('_migrations');
  });

  it('is idempotent — running twice does not error', () => {
    initSchema(db);
    runMigrations(db);
    runMigrations(db);

    const applied = db.prepare('SELECT count(*) as c FROM _migrations').get() as { c: number };
    expect(applied.c).toBeGreaterThan(0);
  });

  it('tracks applied migration indices', () => {
    initSchema(db);
    runMigrations(db);

    const indices = db
      .prepare('SELECT idx FROM _migrations ORDER BY idx')
      .all()
      .map((r) => (r as { idx: number }).idx);

    expect(indices[0]).toBe(0);
    expect(indices.length).toBeGreaterThan(5);
  });
});

describe('normalizeStoredPaths', () => {
  it('trims trailing spaces from file stems', () => {
    initSchema(db);
    runMigrations(db);
    const accessor = makeAccessor();

    db.prepare('INSERT INTO files (path, file_id) VALUES (?, ?)').run('notes/hello .md', 'f1');

    normalizeStoredPaths(db, accessor);

    const row = db.prepare('SELECT path FROM files').get() as { path: string };
    expect(row.path).toBe('notes/hello.md');
  });

  it('runs only once (idempotent via flag)', () => {
    initSchema(db);
    runMigrations(db);
    const accessor = makeAccessor();

    db.prepare('INSERT INTO files (path, file_id) VALUES (?, ?)').run('a .md', 'f1');
    normalizeStoredPaths(db, accessor);

    db.prepare('INSERT INTO files (path, file_id) VALUES (?, ?)').run('b .md', 'f2');
    normalizeStoredPaths(db, accessor);

    const paths = db
      .prepare('SELECT path FROM files')
      .all()
      .map((r) => (r as { path: string }).path);
    expect(paths).toContain('b .md');
  });

  it('resets cloud version cache when paths change', () => {
    initSchema(db);
    runMigrations(db);
    const accessor = makeAccessor();
    accessor.setState('last_cloud_version', '42');

    db.prepare('INSERT INTO files (path, file_id) VALUES (?, ?)').run('trail .md', 'f1');
    normalizeStoredPaths(db, accessor);

    expect(accessor.getState('last_cloud_version')).toBe('0');
  });
});

describe('normalizeStoredChars', () => {
  it('sanitizes filenames using provided function', () => {
    initSchema(db);
    runMigrations(db);
    const accessor = makeAccessor();

    db.prepare('INSERT INTO files (path, file_id) VALUES (?, ?)').run('notes/bad:name.md', 'f1');

    normalizeStoredChars(db, accessor, (name) => name.replace(/:/g, '_'));

    const row = db.prepare('SELECT path FROM files').get() as { path: string };
    expect(row.path).toBe('notes/bad_name.md');
  });
});

describe('runAllMigrations', () => {
  it('runs schema + migrations + normalizations in order', () => {
    const accessor = makeAccessor();
    runAllMigrations(db, accessor, (n) => n);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toContain('files');
    expect(tables).toContain('sync_log');
    expect(tables).toContain('file_base');
    expect(accessor.getState('paths_normalized_v1')).toBe('1');
    expect(accessor.getState('paths_normalized_v2')).toBe('1');
  });
});
