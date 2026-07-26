import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnvFile } from './load-env.js';

describe('loadEnvFile', () => {
  let dir: string;
  let key: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'load-env-'));
    key = `YOUDAONOTE_TEST_ENV_${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    // Clear without dynamic delete: assign then rely on unique key per test.
    process.env[key] = '';
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads KEY=VALUE from .env', () => {
    const file = join(dir, '.env');
    writeFileSync(file, `${key}=hello\n`);
    loadEnvFile(file);
    expect(process.env[key]).toBe('hello');
  });

  it('does not override existing env', () => {
    process.env[key] = 'keep';
    const file = join(dir, '.env');
    writeFileSync(file, `${key}=replace\n`);
    loadEnvFile(file);
    expect(process.env[key]).toBe('keep');
  });

  it('ignores missing file', () => {
    expect(() => {
      loadEnvFile(join(dir, 'missing.env'));
    }).not.toThrow();
  });
});
