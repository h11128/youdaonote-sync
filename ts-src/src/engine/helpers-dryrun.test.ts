import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { printPreview, printDryrunSummary, diagnoseDryrun } from './helpers.js';
import { groupByAction, writeDryrunReport } from './helpers-dryrun.js';
import type { FileState } from '../types/state.js';
import type { MetadataStore } from '../metadata/store.js';
import { asRelPath } from '../types/common.js';
import type { RelPath } from '../types/common.js';

const noop = vi.fn();

describe('printPreview', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(noop);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints grouped actions for non-skip entries', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('cloud.md'), { kind: 'cloudNew' }],
      [asRelPath('local.md'), { kind: 'localNew' }],
      [asRelPath('both.md'), { kind: 'conflict' }],
      [asRelPath('synced.md'), { kind: 'synced' }],
    ]);

    printPreview(classified);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('DOWNLOAD');
    expect(output).toContain('cloud.md');
    expect(output).toContain('UPLOAD');
    expect(output).toContain('local.md');
    expect(output).toContain('CONFLICT');
    expect(output).toContain('both.md');
    expect(output).not.toContain('synced.md');
  });

  it('prints nothing for all-skip entries', () => {
    const classified = new Map<RelPath, FileState>([[asRelPath('a.md'), { kind: 'synced' }]]);

    printPreview(classified);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Dry-Run Preview');
    expect(output).not.toContain('DOWNLOAD');
    expect(output).not.toContain('UPLOAD');
  });
});

describe('printDryrunSummary', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(noop);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints correct counts', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('a.md'), { kind: 'cloudNew' }],
      [asRelPath('b.md'), { kind: 'cloudNew' }],
      [asRelPath('c.md'), { kind: 'localNew' }],
      [asRelPath('d.md'), { kind: 'conflict' }],
      [asRelPath('e.md'), { kind: 'synced' }],
    ]);

    printDryrunSummary(classified);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Total changes: 4');
    expect(output).toContain('1 unchanged');
    expect(output).toContain('Downloads: 2');
    expect(output).toContain('Uploads:   1');
    expect(output).toContain('Conflicts: 1');
  });

  it('omits zero-count categories', () => {
    const classified = new Map<RelPath, FileState>([[asRelPath('a.md'), { kind: 'localNew' }]]);

    printDryrunSummary(classified);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Uploads:   1');
    expect(output).not.toContain('Downloads');
    expect(output).not.toContain('Conflicts');
  });
});

describe('diagnoseDryrun', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(noop);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('outputs preview, summary, and warnings together', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('upload.md'), { kind: 'localNew' }],
    ]);
    const meta = {
      getFileInfo: () => null,
    } as unknown as MetadataStore;

    diagnoseDryrun(classified, meta);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Dry-Run Preview');
    expect(output).toContain('Dry-Run Summary');
  });
});

describe('groupByAction', () => {
  it('groups entries by their sync action', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('a.md'), { kind: 'cloudNew' }],
      [asRelPath('b.md'), { kind: 'localNew' }],
      [asRelPath('c.md'), { kind: 'cloudNew' }],
      [asRelPath('d.md'), { kind: 'synced' }],
    ]);

    const groups = groupByAction(classified);

    expect(groups.get('download')).toEqual([asRelPath('a.md'), asRelPath('c.md')]);
    expect(groups.get('upload')).toEqual([asRelPath('b.md')]);
    expect(groups.get('skip')).toEqual([asRelPath('d.md')]);
    expect(groups.get('conflict')).toBeUndefined();
  });

  it('returns empty map for empty input', () => {
    const groups = groupByAction(new Map());
    expect(groups.size).toBe(0);
  });
});

describe('writeDryrunReport', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dryrun-report-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a markdown report file and returns its path', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('a.md'), { kind: 'cloudNew' }],
      [asRelPath('b.md'), { kind: 'localNew' }],
      [asRelPath('c.md'), { kind: 'synced' }],
    ]);

    const reportPath = writeDryrunReport(classified, [], tmpDir);

    expect(reportPath).toContain('.local-reports');
    expect(reportPath).toMatch(/dry-run-.*\.md$/);
    const content = readFileSync(reportPath, 'utf-8');
    expect(content).toContain('# Dry-Run Report');
    expect(content).toContain('Total changes | 2');
    expect(content).toContain('↓ Download');
    expect(content).toContain('a.md');
    expect(content).toContain('↑ Upload');
    expect(content).toContain('b.md');
    expect(content).toContain('Unchanged (skipped) | 1');
  });

  it('includes warnings section when warnings are provided', () => {
    const classified = new Map<RelPath, FileState>([[asRelPath('x.md'), { kind: 'localNew' }]]);
    const warnings = [{ path: asRelPath('x.md'), reasons: ['hash mismatch', 'mtime differs'] }];

    const reportPath = writeDryrunReport(classified, warnings, tmpDir);
    const content = readFileSync(reportPath, 'utf-8');

    expect(content).toContain('Suspicious Uploads');
    expect(content).toContain('x.md');
    expect(content).toContain('hash mismatch');
    expect(content).toContain('mtime differs');
  });

  it('omits warnings section when no warnings', () => {
    const classified = new Map<RelPath, FileState>([[asRelPath('a.md'), { kind: 'localNew' }]]);

    const reportPath = writeDryrunReport(classified, [], tmpDir);
    const content = readFileSync(reportPath, 'utf-8');

    expect(content).not.toContain('Suspicious');
  });
});
