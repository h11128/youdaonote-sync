import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gitAutoCommit, gitInit } from './git.js';

function setupGitRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'git-test-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'init.md'), 'initial');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('gitAutoCommit', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = setupGitRepo());
  });
  afterEach(() => {
    cleanup();
  });

  it('commits changed files with auto-generated message', () => {
    writeFileSync(join(dir, 'new.md'), 'content');

    const ok = gitAutoCommit(dir, {
      changedPaths: [join(dir, 'new.md')],
      stats: { downloaded: 1, uploaded: 0, conflicts: 0 },
    });

    expect(ok).toBe(true);
    const log = execFileSync('git', ['log', '--oneline', '-1'], {
      cwd: dir,
      encoding: 'utf-8',
    });
    expect(log).toContain('sync:');
    expect(log).toContain('↓1');
  });

  it('handles commit message with quotes and special characters', () => {
    writeFileSync(join(dir, 'special.md'), 'data');

    const ok = gitAutoCommit(dir, {
      message: 'sync: file "test\'s $HOME" & `backtick`',
      changedPaths: [join(dir, 'special.md')],
    });

    expect(ok).toBe(true);
    const log = execFileSync('git', ['log', '--format=%s', '-1'], {
      cwd: dir,
      encoding: 'utf-8',
    });
    expect(log.trim()).toBe('sync: file "test\'s $HOME" & `backtick`');
  });

  it('stages dedup deleted paths with git add -u', () => {
    writeFileSync(join(dir, 'dup.md'), 'dup');
    execFileSync('git', ['add', 'dup.md'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'add dup'], { cwd: dir, stdio: 'pipe' });
    rmSync(join(dir, 'dup.md'));

    const ok = gitAutoCommit(dir, {
      changedPaths: [],
      dedupDeletedPaths: [join(dir, 'dup.md')],
      stats: { downloaded: 0, uploaded: 0, conflicts: 0, dedupDeleted: 1 },
    });

    expect(ok).toBe(true);
    const log = execFileSync('git', ['log', '--format=%s', '-1'], {
      cwd: dir,
      encoding: 'utf-8',
    });
    expect(log).toContain('sync:');
  });

  it('returns false when no changes to commit', () => {
    const ok = gitAutoCommit(dir);
    expect(ok).toBe(false);
  });

  it('returns false when localDir has no .git', () => {
    const noGit = mkdtempSync(join(tmpdir(), 'no-git-'));
    writeFileSync(join(noGit, 'file.md'), 'data');

    const ok = gitAutoCommit(noGit, { changedPaths: [join(noGit, 'file.md')] });

    expect(ok).toBe(false);
    rmSync(noGit, { recursive: true, force: true });
  });
});

describe('gitInit', () => {
  it('initializes a new git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-init-'));
    expect(gitInit(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns true for existing repo', () => {
    const { dir, cleanup } = setupGitRepo();
    expect(gitInit(dir)).toBe(true);
    cleanup();
  });
});
