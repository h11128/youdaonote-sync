import { copyFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * Create a conflict backup of a file.
 * Returns the backup path, or null if the source doesn't exist.
 */
export function backupFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;

  const now = new Date();
  const ts =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') + '_' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0') +
    String(now.getMilliseconds()).padStart(3, '0');

  const ext = extname(filePath);
  const base = filePath.slice(0, -ext.length || undefined);
  const backupPath = `${base}.conflict.${ts}${ext}`;

  try {
    copyFileSync(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}
