import { existsSync, renameSync, unlinkSync } from 'node:fs';

function fsErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code?: unknown }).code);
  }
  return '';
}

/**
 * Move `tmpPath` onto `targetPath`. On Windows EPERM/EEXIST when replacing,
 * move the target aside first, then restore it if the final rename fails —
 * never unlink the target before the new file is in place.
 */
export function renameReplace(tmpPath: string, targetPath: string): void {
  try {
    renameSync(tmpPath, targetPath);
    return;
  } catch (renameErr: unknown) {
    const code = fsErrorCode(renameErr);
    if (code !== 'EPERM' && code !== 'EEXIST') throw renameErr;
  }
  replaceViaBackup(tmpPath, targetPath);
}

/**
 * Replace target without risking total loss: move target aside, move tmp in,
 * then delete backup. If the second rename fails, restore the backup.
 */
export function replaceViaBackup(tmpPath: string, targetPath: string): void {
  const bakPath = `${targetPath}.bak.${Date.now()}`;
  let movedTarget = false;
  try {
    if (existsSync(targetPath)) {
      renameSync(targetPath, bakPath);
      movedTarget = true;
    }
    renameSync(tmpPath, targetPath);
    if (movedTarget) {
      try {
        unlinkSync(bakPath);
      } catch {
        /* leave backup if unlink fails */
      }
    }
  } catch (err) {
    if (movedTarget && existsSync(bakPath) && !existsSync(targetPath)) {
      try {
        renameSync(bakPath, targetPath);
      } catch {
        /* bakPath still holds original */
      }
    }
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
