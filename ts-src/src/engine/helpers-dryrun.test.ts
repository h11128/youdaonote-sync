import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  effectiveAction,
  printPreview,
  printDryrunSummary,
  diagnoseDryrun,
  dryRunStats,
  groupByAction,
  writeDryrunReport,
} from './helpers-dryrun.js';
import type { FileState } from '../types/state.js';
import type { MetadataStore } from '../metadata/store.js';
import { asContentHash, asEpochSeconds, asRelPath } from '../types/common.js';
import type { ContentHash, FileId, RelPath } from '../types/common.js';

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

  it('prints DELETE CLOUD and DELETE LOCAL sections when deleteOverrides provided', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('local-gone.md'), { kind: 'localDeleted' }],
      [asRelPath('cloud-gone.md'), { kind: 'cloudDeleted' }],
    ]);
    const overrides = new Map<RelPath, 'deleteCloud' | 'deleteLocal'>([
      [asRelPath('local-gone.md'), 'deleteCloud'],
      [asRelPath('cloud-gone.md'), 'deleteLocal'],
    ]);

    printPreview(classified, overrides);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('DELETE CLOUD');
    expect(output).toContain('local-gone.md');
    expect(output).toContain('DELETE LOCAL');
    expect(output).toContain('cloud-gone.md');
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
    expect(output).toContain('Downloads:');
    expect(output).toContain('2');
    expect(output).toContain('Uploads:');
    expect(output).toContain('Conflicts:');
  });

  it('prints Delete cloud and Delete local counts with deleteOverrides', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('local-gone.md'), { kind: 'localDeleted' }],
      [asRelPath('cloud-gone.md'), { kind: 'cloudDeleted' }],
      [asRelPath('ok.md'), { kind: 'synced' }],
    ]);
    const overrides = new Map<RelPath, 'deleteCloud' | 'deleteLocal'>([
      [asRelPath('local-gone.md'), 'deleteCloud'],
      [asRelPath('cloud-gone.md'), 'deleteLocal'],
    ]);

    printDryrunSummary(classified, overrides);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Delete cloud:');
    expect(output).toContain('Delete local:');
    expect(output).toContain('Total changes: 2');
    expect(output).toContain('1 unchanged');
  });

  it('omits zero-count categories', () => {
    const classified = new Map<RelPath, FileState>([[asRelPath('a.md'), { kind: 'localNew' }]]);

    printDryrunSummary(classified);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Uploads:');
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

  it('shows hash change warning when localHashes differ from metadata', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('changed.md'), { kind: 'localModified' }],
    ]);
    const meta = {
      getFileInfo: (path: RelPath) => {
        if (path === asRelPath('changed.md')) {
          return {
            fileId: 'f-1' as FileId,
            cloudMtime: asEpochSeconds(100),
            localMtime: asEpochSeconds(100),
            contentHash: asContentHash('old-hash'),
            lastSyncAt: asEpochSeconds(50),
          };
        }
        return null;
      },
    } as unknown as MetadataStore;
    const localHashes = new Map<RelPath, ContentHash | null>([
      [asRelPath('changed.md'), asContentHash('new-hash')],
    ]);

    diagnoseDryrun(classified, meta, { localHashes });

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('hash: old-hash → new-hash');
    expect(output).toContain('可疑 UPLOAD');
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

  it('groups deleteCloud and deleteLocal via overrides', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('local-gone.md'), { kind: 'localDeleted' }],
      [asRelPath('cloud-gone.md'), { kind: 'cloudDeleted' }],
      [asRelPath('normal.md'), { kind: 'localNew' }],
    ]);
    const overrides = new Map<RelPath, 'deleteCloud' | 'deleteLocal'>([
      [asRelPath('local-gone.md'), 'deleteCloud'],
      [asRelPath('cloud-gone.md'), 'deleteLocal'],
    ]);

    const groups = groupByAction(classified, overrides);

    expect(groups.get('deleteCloud')).toEqual([asRelPath('local-gone.md')]);
    expect(groups.get('deleteLocal')).toEqual([asRelPath('cloud-gone.md')]);
    expect(groups.get('upload')).toEqual([asRelPath('normal.md')]);
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

describe('effectiveAction', () => {
  it('returns stateToAction result when no overrides', () => {
    expect(effectiveAction({ kind: 'localNew' }, asRelPath('a.md'))).toBe('upload');
    expect(effectiveAction({ kind: 'cloudNew' }, asRelPath('b.md'))).toBe('download');
    expect(effectiveAction({ kind: 'synced' }, asRelPath('c.md'))).toBe('skip');
  });

  it('returns stateToAction result when path not in overrides', () => {
    const overrides = new Map<RelPath, 'deleteCloud' | 'deleteLocal'>([
      [asRelPath('other.md'), 'deleteCloud'],
    ]);

    expect(effectiveAction({ kind: 'localNew' }, asRelPath('a.md'), overrides)).toBe('upload');
  });

  it('returns deleteCloud override for localDeleted state', () => {
    const overrides = new Map<RelPath, 'deleteCloud' | 'deleteLocal'>([
      [asRelPath('a.md'), 'deleteCloud'],
    ]);

    expect(effectiveAction({ kind: 'localDeleted' }, asRelPath('a.md'), overrides)).toBe(
      'deleteCloud',
    );
  });

  it('returns deleteLocal override for cloudDeleted state', () => {
    const overrides = new Map<RelPath, 'deleteCloud' | 'deleteLocal'>([
      [asRelPath('a.md'), 'deleteLocal'],
    ]);

    expect(effectiveAction({ kind: 'cloudDeleted' }, asRelPath('a.md'), overrides)).toBe(
      'deleteLocal',
    );
  });

  it('override takes precedence over stateToAction', () => {
    const overrides = new Map<RelPath, 'deleteCloud' | 'deleteLocal'>([
      [asRelPath('a.md'), 'deleteCloud'],
    ]);

    expect(effectiveAction({ kind: 'localNew' }, asRelPath('a.md'), overrides)).toBe('deleteCloud');
  });
});

describe('dryRunStats', () => {
  it('counts basic actions correctly', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('a.md'), { kind: 'cloudNew' }],
      [asRelPath('b.md'), { kind: 'localNew' }],
      [asRelPath('c.md'), { kind: 'conflict' }],
      [asRelPath('d.md'), { kind: 'synced' }],
    ]);

    const stats = dryRunStats(classified);

    expect(stats.downloaded).toBe(1);
    expect(stats.uploaded).toBe(1);
    expect(stats.conflicts).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.deletedCloud).toBe(0);
    expect(stats.deletedLocal).toBe(0);
  });

  it('counts deleteCloud and deleteLocal with overrides', () => {
    const classified = new Map<RelPath, FileState>([
      [asRelPath('gone-local.md'), { kind: 'localDeleted' }],
      [asRelPath('gone-cloud.md'), { kind: 'cloudDeleted' }],
      [asRelPath('synced.md'), { kind: 'synced' }],
    ]);
    const overrides = new Map<RelPath, 'deleteCloud' | 'deleteLocal'>([
      [asRelPath('gone-local.md'), 'deleteCloud'],
      [asRelPath('gone-cloud.md'), 'deleteLocal'],
    ]);

    const stats = dryRunStats(classified, overrides);

    expect(stats.deletedCloud).toBe(1);
    expect(stats.deletedLocal).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.downloaded).toBe(0);
  });

  it('returns frozen stats object', () => {
    const stats = dryRunStats(new Map());
    expect(Object.isFrozen(stats)).toBe(true);
  });
});
