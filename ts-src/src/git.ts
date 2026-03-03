import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface GitCommitOpts {
  message?: string;
  changedPaths?: string[];
  dedupDeletedPaths?: string[];
  stats?: { downloaded: number; uploaded: number; conflicts: number; dedupDeleted?: number };
}

/**
 * Auto-commit changes in the local note directory after sync.
 * Selectively adds only changed files (matches Python commit_sync).
 */
export function gitAutoCommit(localDir: string, opts?: GitCommitOpts): boolean {
  if (!existsSync(join(localDir, '.git'))) return false;

  try {
    const changedPaths = opts?.changedPaths;
    const dedupDeletedPaths = opts?.dedupDeletedPaths;

    if (changedPaths && changedPaths.length > 0) {
      const BATCH = 50;
      for (let i = 0; i < changedPaths.length; i += BATCH) {
        const batch = changedPaths.slice(i, i + BATCH).filter(p => existsSync(p));
        if (batch.length > 0) {
          execSync(`git add -- ${batch.map(p => `"${p}"`).join(' ')}`, {
            cwd: localDir, stdio: 'pipe',
          });
        }
      }

      if (dedupDeletedPaths && dedupDeletedPaths.length > 0) {
        for (let i = 0; i < dedupDeletedPaths.length; i += BATCH) {
          const batch = dedupDeletedPaths.slice(i, i + BATCH);
          execSync(`git add -u -- ${batch.map(p => `"${p}"`).join(' ')}`, {
            cwd: localDir, stdio: 'pipe',
          });
        }
      }
    } else {
      execSync('git add -A', { cwd: localDir, stdio: 'pipe' });
    }

    const status = execSync('git status --porcelain', {
      cwd: localDir,
      encoding: 'utf-8',
    }).trim();

    if (!status) return false;

    const s = opts?.stats;
    let commitMsg = opts?.message;
    if (!commitMsg) {
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const parts: string[] = [];
      if (s?.downloaded) parts.push(`↓${s.downloaded}`);
      if (s?.uploaded) parts.push(`↑${s.uploaded}`);
      if (s?.conflicts) parts.push(`⚡${s.conflicts}`);
      if (s?.dedupDeleted) parts.push(`🗑${s.dedupDeleted}`);
      commitMsg = parts.length > 0
        ? `sync: ${parts.join(' ')} (${now})`
        : `sync: auto-commit (${now})`;
    }

    execSync(`git commit --no-verify -m "${commitMsg}"`, {
      cwd: localDir,
      stdio: 'pipe',
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Retrieve file content from git history (for diff3 base fallback).
 * Returns null if not a git repo or file not found in history.
 */
export function getFileContentFromGit(
  localDir: string,
  relPath: string,
  ref = 'HEAD',
): Buffer | null {
  if (!existsSync(join(localDir, '.git'))) return null;
  try {
    const result = execSync(`git show "${ref}:${relPath}"`, {
      cwd: localDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    return Buffer.from(result);
  } catch {
    return null;
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
