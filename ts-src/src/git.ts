import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Auto-commit changes in the local note directory after sync.
 */
export function gitAutoCommit(localDir: string, message?: string): boolean {
  if (!existsSync(join(localDir, '.git'))) return false;

  try {
    execSync('git add -A', { cwd: localDir, stdio: 'pipe' });

    const status = execSync('git status --porcelain', {
      cwd: localDir,
      encoding: 'utf-8',
    }).trim();

    if (!status) return false;

    const commitMsg = message ?? `sync: auto-commit at ${new Date().toISOString()}`;
    execSync(`git commit -m "${commitMsg}"`, {
      cwd: localDir,
      stdio: 'pipe',
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize a git repository in the local directory if not already present.
 */
export function gitInit(localDir: string): boolean {
  if (existsSync(join(localDir, '.git'))) return true;
  try {
    execSync('git init', { cwd: localDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
