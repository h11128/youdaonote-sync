import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface GitCommitOpts {
  message?: string;
  changedPaths?: string[];
  dedupDeletedPaths?: string[];
  stats?: { downloaded: number; uploaded: number; conflicts: number; dedupDeleted?: number };
}

const BATCH = 50;
const stdioPipe = 'pipe' as const;

function stageChangedPaths(localDir: string, paths: string[]): void {
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH).filter((p) => existsSync(p));
    if (batch.length > 0) {
      execFileSync('git', ['add', '--', ...batch], { cwd: localDir, stdio: stdioPipe });
    }
  }
}

function stageDedupDeletedPaths(localDir: string, paths: string[]): void {
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    execFileSync('git', ['add', '-u', '--', ...batch], { cwd: localDir, stdio: stdioPipe });
  }
}

function stageFiles(localDir: string, opts: GitCommitOpts): void {
  const { changedPaths, dedupDeletedPaths } = opts;

  if (changedPaths && changedPaths.length > 0) {
    stageChangedPaths(localDir, changedPaths);
    if (dedupDeletedPaths && dedupDeletedPaths.length > 0) {
      stageDedupDeletedPaths(localDir, dedupDeletedPaths);
    }
  } else {
    execFileSync('git', ['add', '-A'], { cwd: localDir, stdio: stdioPipe });
  }
}

function buildCommitMessage(opts?: GitCommitOpts): string {
  const msg = opts?.message;
  if (msg) return msg;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const s = opts?.stats;
  const parts: string[] = [];
  if (s?.downloaded) parts.push(`↓${s.downloaded}`);
  if (s?.uploaded) parts.push(`↑${s.uploaded}`);
  if (s?.conflicts) parts.push(`⚡${s.conflicts}`);
  if (s?.dedupDeleted) parts.push(`🗑${s.dedupDeleted}`);
  return parts.length > 0 ? `sync: ${parts.join(' ')} (${now})` : `sync: auto-commit (${now})`;
}

/**
 * Auto-commit changes in the local note directory after sync.
 * Selectively adds only changed files (matches Python commit_sync).
 */
export function gitAutoCommit(localDir: string, opts?: GitCommitOpts): boolean {
  if (!existsSync(join(localDir, '.git'))) return false;

  try {
    stageFiles(localDir, opts ?? {});

    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: localDir,
      encoding: 'utf-8',
    }).trim();
    if (!status) return false;

    const commitMsg = buildCommitMessage(opts);
    execFileSync('git', ['commit', '--no-verify', '-m', commitMsg], {
      cwd: localDir,
      stdio: stdioPipe,
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
    const result = execFileSync('git', ['show', `${ref}:${relPath}`], {
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
    execFileSync('git', ['init'], { cwd: localDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
