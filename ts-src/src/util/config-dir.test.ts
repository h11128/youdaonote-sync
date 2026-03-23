import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateConfigFiles } from './config-dir.js';

describe('migrateConfigFiles', () => {
  let tmpDir: string;
  let oldDir: string;
  let newDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'config-migrate-'));
    oldDir = join(tmpDir, 'old');
    newDir = join(tmpDir, 'new');
    mkdirSync(oldDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies config.json, cookies.json, sync_metadata.db from old to new', () => {
    writeFileSync(join(oldDir, 'config.json'), '{"key":"value"}');
    writeFileSync(join(oldDir, 'cookies.json'), '[]');
    writeFileSync(join(oldDir, 'sync_metadata.db'), 'fakedb');

    const copied = migrateConfigFiles(oldDir, newDir);

    expect(copied).toEqual(['config.json', 'cookies.json', 'sync_metadata.db']);
    expect(readFileSync(join(newDir, 'config.json'), 'utf-8')).toBe('{"key":"value"}');
    expect(readFileSync(join(newDir, 'cookies.json'), 'utf-8')).toBe('[]');
    expect(readFileSync(join(newDir, 'sync_metadata.db'), 'utf-8')).toBe('fakedb');
  });

  it('skips files that already exist at destination', () => {
    writeFileSync(join(oldDir, 'config.json'), 'old');
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, 'config.json'), 'new');

    vi.spyOn(console, 'warn').mockImplementation(vi.fn());
    const copied = migrateConfigFiles(oldDir, newDir);
    vi.restoreAllMocks();

    expect(copied).toEqual([]);
    expect(readFileSync(join(newDir, 'config.json'), 'utf-8')).toBe('new');
  });

  it('skips files that do not exist in old dir', () => {
    writeFileSync(join(oldDir, 'config.json'), '{}');

    const copied = migrateConfigFiles(oldDir, newDir);

    expect(copied).toEqual(['config.json']);
    expect(existsSync(join(newDir, 'cookies.json'))).toBe(false);
  });

  it('creates the new directory if it does not exist', () => {
    writeFileSync(join(oldDir, 'config.json'), '{}');
    const deepNew = join(tmpDir, 'deep', 'nested', 'new');

    migrateConfigFiles(oldDir, deepNew);

    expect(existsSync(join(deepNew, 'config.json'))).toBe(true);
  });

  it('throws if oldDir or newDir is empty', () => {
    expect(() => migrateConfigFiles('', newDir)).toThrow('required');
    expect(() => migrateConfigFiles(oldDir, '')).toThrow('required');
  });

  it('handles copy errors gracefully', () => {
    writeFileSync(join(oldDir, 'config.json'), '{}');
    mkdirSync(join(newDir, 'config.json'), { recursive: true });

    vi.spyOn(console, 'error').mockImplementation(vi.fn());
    vi.spyOn(console, 'log').mockImplementation(vi.fn());
    const copied = migrateConfigFiles(oldDir, newDir);
    vi.restoreAllMocks();

    expect(copied).toEqual([]);
  });
});
