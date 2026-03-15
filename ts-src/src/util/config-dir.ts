import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * Resolve the youdaonote-sync config directory.
 *
 * Priority:
 * 1. YOUDAONOTE_CONFIG_DIR env var (explicit override)
 * 2. Platform default:
 *    - Windows: %APPDATA%/youdaonote-sync
 *    - Linux/Mac: ~/.config/youdaonote-sync
 *
 * On first run after migration, warns if the old `cwd/config/` layout is
 * detected but the new location is empty.
 */
export function getConfigDir(): string {
  if (process.env.YOUDAONOTE_CONFIG_DIR) {
    return process.env.YOUDAONOTE_CONFIG_DIR;
  }
  const appData = process.env.APPDATA ?? join(homedir(), '.config');
  return join(appData, 'youdaonote-sync');
}

let migrationWarned = false;

/**
 * Check for leftover config in the old `process.cwd()/config/` location
 * and print a one-time migration hint if found.
 */
export function warnIfLegacyConfig(): void {
  if (migrationWarned) return;
  migrationWarned = true;

  const newDir = getConfigDir();
  const oldDir = join(process.cwd(), 'config');
  if (oldDir === newDir) return;

  const newHasConfig = existsSync(join(newDir, 'config.json'));
  const oldHasConfig = existsSync(join(oldDir, 'config.json'));

  if (oldHasConfig && !newHasConfig) {
    console.warn(
      `\n[migrate] Config files found at old location: ${oldDir}` +
        `\n          New location: ${newDir}` +
        `\n          Please move config.json, cookies.json, and sync_metadata.db manually.\n`,
    );
  }
}
