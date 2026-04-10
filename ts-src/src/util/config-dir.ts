import { join } from 'node:path';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { logger } from './logger.js';

/**
 * Resolve the youdaonote-sync config directory.
 *
 * Priority:
 * 1. YOUDAONOTE_CONFIG_DIR env var (explicit override)
 * 2. Platform default:
 *    - Windows: %APPDATA%/youdaonote-sync
 *    - Linux/Mac: ~/.config/youdaonote-sync
 */
export function getConfigDir(): string {
  if (process.env.YOUDAONOTE_CONFIG_DIR) {
    return process.env.YOUDAONOTE_CONFIG_DIR;
  }
  const appData = process.env.APPDATA ?? join(homedir(), '.config');
  return join(appData, APP_NAME);
}

const APP_NAME = 'youdaonote-sync';

const MIGRATE_FILES = ['config.json', 'cookies.json', 'sync_metadata.db'] as const;

let migrationDone = false;

function getLegacyDir(): string {
  return join(process.cwd(), 'config');
}

/**
 * Auto-migrate config from old `cwd/config/` to the platform config dir.
 * Only copies if the new dir has no config.json (avoids overwriting).
 * Called once at CLI startup.
 */
export function warnIfLegacyConfig(): void {
  if (migrationDone) return;
  migrationDone = true;

  if (process.env.YOUDAONOTE_CONFIG_DIR) return;

  const newDir = getConfigDir();
  const oldDir = getLegacyDir();
  if (oldDir === newDir) return;

  const oldHasConfig = existsSync(join(oldDir, 'config.json'));
  const newHasConfig = existsSync(join(newDir, 'config.json'));

  if (oldHasConfig && !newHasConfig) {
    migrateConfigFiles(oldDir, newDir);
  }
}

/**
 * Explicitly migrate config files from old to new location.
 * Returns the list of files successfully copied.
 */
export function migrateConfigFiles(oldDir: string, newDir: string): string[] {
  if (!oldDir || !newDir) throw new Error('migrateConfigFiles: oldDir and newDir are required');
  mkdirSync(newDir, { recursive: true });
  const copied: string[] = [];
  for (const file of MIGRATE_FILES) {
    const src = join(oldDir, file);
    const dest = join(newDir, file);
    if (!existsSync(src)) continue;
    if (existsSync(dest)) {
      logger.warn(`[migrate] Skipped ${file} (already exists at destination)`);
      continue;
    }
    try {
      copyFileSync(src, dest);
      copied.push(file);
    } catch (e: unknown) {
      logger.error(
        `[migrate] Failed to copy ${file}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (copied.length > 0) {
    logger.info(`[migrate] Copied ${copied.join(', ')} from ${oldDir} → ${newDir}`);
  }
  return copied;
}
