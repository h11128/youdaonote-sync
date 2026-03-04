import type Database from 'better-sqlite3';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    file_id TEXT NOT NULL DEFAULT '',
    cloud_mtime INTEGER NOT NULL DEFAULT 0,
    local_mtime INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT,
    domain INTEGER,
    content_hash TEXT,
    create_time INTEGER,
    last_sync_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS directories (
    path TEXT PRIMARY KEY,
    dir_id TEXT NOT NULL DEFAULT '',
    parent_id TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_file_id ON files(file_id) WHERE file_id != '';
CREATE INDEX IF NOT EXISTS idx_content_hash ON files(content_hash) WHERE content_hash IS NOT NULL AND content_hash != '';
CREATE INDEX IF NOT EXISTS idx_dir_id ON directories(dir_id) WHERE dir_id != '';
`;

const MIGRATION_SQL: readonly string[] = [
  'ALTER TABLE files ADD COLUMN last_sync_at INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE files ADD COLUMN cloud_content_hash TEXT',
  'ALTER TABLE directories ADD COLUMN tree_hash TEXT',
  `CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      path TEXT NOT NULL,
      action TEXT NOT NULL,
      direction TEXT,
      old_hash TEXT,
      new_hash TEXT,
      cloud_id TEXT,
      detail TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sync_log_ts ON sync_log(timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_sync_log_path ON sync_log(path)',
  `CREATE TABLE IF NOT EXISTS file_refs (
      source_path TEXT NOT NULL,
      ref_path TEXT NOT NULL,
      PRIMARY KEY (source_path, ref_path)
  )`,
  `CREATE TABLE IF NOT EXISTS file_base (
      path TEXT PRIMARY KEY,
      content BLOB NOT NULL,
      hash TEXT NOT NULL,
      saved_at INTEGER NOT NULL
  )`,
  'UPDATE files SET content_hash = NULL WHERE content_hash IS NOT NULL',
  `CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
  )`,
  'ALTER TABLE files ADD COLUMN original_domain INTEGER',
];

export function initSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}

export function runMigrations(db: Database.Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations ' +
      '(idx INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const applied = new Set(
    db
      .prepare('SELECT idx FROM _migrations')
      .all()
      .map((r) => (r as { idx: number }).idx),
  );

  const EXPECTED_ERRORS = ['duplicate column', 'already exists'];

  for (let i = 0; i < MIGRATION_SQL.length; i++) {
    if (applied.has(i)) continue;
    const sql = MIGRATION_SQL[i];
    if (sql == null) continue;
    try {
      db.exec(sql);
    } catch (e: unknown) {
      const msg = String(e).toLowerCase();
      if (!EXPECTED_ERRORS.some((phrase) => msg.includes(phrase))) {
        throw e;
      }
    }
    db.prepare('INSERT OR IGNORE INTO _migrations (idx, applied_at) VALUES (?, ?)').run(
      i,
      Math.floor(Date.now() / 1000),
    );
  }
}

export interface StateAccessor {
  getState(key: string): string | null;
  setState(key: string, value: string): void;
}

function computeNewPath(oldPath: string): string {
  const slashIdx = oldPath.lastIndexOf('/');
  const prefix = slashIdx >= 0 ? oldPath.slice(0, slashIdx + 1) : '';
  const basename = slashIdx >= 0 ? oldPath.slice(slashIdx + 1) : oldPath;
  const dotIdx = basename.lastIndexOf('.');
  const stem = dotIdx >= 0 ? basename.slice(0, dotIdx) : basename;
  const ext = dotIdx >= 0 ? basename.slice(dotIdx) : '';
  const newStem = stem.trimEnd();
  return prefix + newStem + ext;
}

function applyPathRename(
  db: Database.Database,
  table: 'files' | 'directories',
  oldPath: string,
  newPath: string,
): void {
  const existing = db.prepare(`SELECT 1 FROM ${table} WHERE path = ?`).get(newPath);
  if (existing) {
    db.prepare(`DELETE FROM ${table} WHERE path = ?`).run(oldPath);
  } else {
    db.prepare(`UPDATE ${table} SET path = ? WHERE path = ?`).run(newPath, oldPath);
  }
}

export function normalizeStoredPaths(db: Database.Database, accessor: StateAccessor): void {
  const FLAG = 'paths_normalized_v1';
  if (accessor.getState(FLAG)) return;

  let renamed = 0;
  for (const table of ['files', 'directories'] as const) {
    const rows = db.prepare(`SELECT path FROM ${table}`).all() as { path: string }[];
    for (const { path: oldPath } of rows) {
      const newPath = computeNewPath(oldPath);
      if (newPath === oldPath) continue;
      applyPathRename(db, table, oldPath, newPath);
      renamed++;
    }
  }

  accessor.setState(FLAG, '1');
  if (renamed > 0) {
    accessor.setState('last_cloud_version', '0');
  }
}

export function normalizeStoredChars(
  db: Database.Database,
  accessor: StateAccessor,
  sanitize: (name: string) => string,
): void {
  const FLAG = 'paths_normalized_v2';
  if (accessor.getState(FLAG)) return;

  let renamed = 0;
  for (const table of ['files', 'directories'] as const) {
    const rows = db.prepare(`SELECT path FROM ${table}`).all() as { path: string }[];
    for (const { path: oldPath } of rows) {
      const slashIdx = oldPath.lastIndexOf('/');
      const prefix = slashIdx >= 0 ? oldPath.slice(0, slashIdx + 1) : '';
      const basename = slashIdx >= 0 ? oldPath.slice(slashIdx + 1) : oldPath;
      const newPath = prefix + sanitize(basename);
      if (newPath === oldPath) continue;
      applyPathRename(db, table, oldPath, newPath);
      renamed++;
    }
  }

  accessor.setState(FLAG, '1');
  if (renamed > 0) {
    accessor.setState('last_cloud_version', '0');
  }
}

export function runAllMigrations(
  db: Database.Database,
  accessor: StateAccessor,
  sanitize: (name: string) => string,
): void {
  initSchema(db);
  runMigrations(db);
  normalizeStoredPaths(db, accessor);
  normalizeStoredChars(db, accessor, sanitize);
}
