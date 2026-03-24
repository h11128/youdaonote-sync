import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cmdDuplicates,
  cmdLocalStats,
  cmdResetCache,
  cmdCache,
  cmdPath,
  cmdDecision,
  cmdSummary,
  cmdCheckContent,
} from './diagnose.js';
import { MetadataStore } from '../metadata/store.js';
import { asFileId, asEpochSeconds, asRelPath, type RelPath } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';

const engineMethods = vi.hoisted(() => {
  const collectItems = vi.fn();
  const close = vi.fn();
  return { collectItems, close };
});

vi.mock('../engine/engine.js', () => ({
  SyncEngine: class {
    collectItems = engineMethods.collectItems;
    close = engineMethods.close;
  },
}));

let tempDir: string;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  tempDir = mkdtempSync(join(tmpdir(), 'diag-test-'));
  engineMethods.collectItems.mockClear();
  engineMethods.close.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('cmdDuplicates', () => {
  const cases = [
    {
      name: 'identical files (same name, same content)',
      setup: (dir: string) => {
        mkdirSync(join(dir, 'subdir'), { recursive: true });
        writeFileSync(join(dir, 'file1.md'), 'hello world');
        writeFileSync(join(dir, 'subdir', 'file1.md'), 'hello world');
      },
      expects: [/Identical \(same content\):\s+1 groups/, /CRLF-only differences:\s+0 groups/],
    },
    {
      name: 'CRLF-only differences',
      setup: (dir: string) => {
        mkdirSync(join(dir, 'a'), { recursive: true });
        mkdirSync(join(dir, 'b'), { recursive: true });
        writeFileSync(join(dir, 'a', 'readme.md'), 'line1\nline2');
        writeFileSync(join(dir, 'b', 'readme.md'), 'line1\r\nline2');
      },
      expects: [/CRLF-only differences:\s+1 groups/],
    },
    {
      name: 'real content differences',
      setup: (dir: string) => {
        mkdirSync(join(dir, 'x'), { recursive: true });
        mkdirSync(join(dir, 'y'), { recursive: true });
        writeFileSync(join(dir, 'x', 'note.md'), 'content A');
        writeFileSync(join(dir, 'y', 'note.md'), 'content B');
      },
      expects: [/Real content differences:\s+1 groups/],
    },
    {
      name: 'no duplicates when files have unique names',
      setup: (dir: string) => {
        writeFileSync(join(dir, 'a.md'), 'x');
        writeFileSync(join(dir, 'b.md'), 'x');
      },
      expects: [/Identical \(same content\):\s+0 groups/],
    },
    {
      name: 'skips .conflict files',
      setup: (dir: string) => {
        writeFileSync(join(dir, 'file.md'), 'a');
        writeFileSync(join(dir, 'file.conflict.123.md'), 'a');
      },
      expects: [/Identical \(same content\):\s+0 groups/],
    },
  ];

  for (const { name, setup, expects } of cases) {
    it(name, () => {
      setup(tempDir);
      const logSpy = vi.spyOn(console, 'log');

      cmdDuplicates(tempDir);

      for (const pattern of expects) {
        expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(pattern));
      }
    });
  }
});

describe('cmdLocalStats', () => {
  const statsCases = [
    {
      name: 'counts .md, .note, images, and other files',
      setup: (dir: string) => {
        mkdirSync(join(dir, 'notes', 'images'), { recursive: true });
        mkdirSync(join(dir, 'notes', 'attachments'), { recursive: true });
        writeFileSync(join(dir, 'file1.md'), '');
        writeFileSync(join(dir, 'file2.md'), '');
        writeFileSync(join(dir, 'note.note'), '');
        writeFileSync(join(dir, 'notes', 'images', 'img.png'), '');
        writeFileSync(join(dir, 'notes', 'attachments', 'doc.pdf'), '');
        writeFileSync(join(dir, 'other.txt'), '');
      },
      expects: [/\.md files:\s+2/, /\.note files:\s+1/, /images\/attach:\s+2/, /other files:\s+1/],
    },
    {
      name: 'handles empty directory',
      setup: () => undefined,
      expects: [/\.md files:\s+0/, /\.note files:\s+0/],
    },
    {
      name: 'skips hidden files and directories',
      setup: (dir: string) => {
        mkdirSync(join(dir, '.hidden'), { recursive: true });
        writeFileSync(join(dir, '.gitignore'), '');
        writeFileSync(join(dir, 'visible.md'), '');
      },
      expects: [/\.md files:\s+1/],
    },
  ];

  for (const { name, setup, expects } of statsCases) {
    it(name, () => {
      setup(tempDir);
      const logSpy = vi.spyOn(console, 'log');

      cmdLocalStats(tempDir);

      for (const pattern of expects) {
        expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(pattern));
      }
    });
  }
});

describe('cmdResetCache', () => {
  it('resets last_cloud_version and last_scan_time to 0', () => {
    const metaPath = join(tempDir, 'test.db');
    const meta = new MetadataStore(metaPath);
    meta.setState('last_cloud_version', '42');
    meta.setState('last_scan_time', '12345');
    meta.close();

    cmdResetCache({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir: tempDir,
    });

    const meta2 = new MetadataStore(metaPath);
    expect(meta2.getState('last_cloud_version')).toBe('0');
    expect(meta2.getState('last_scan_time')).toBe('0');
    meta2.close();
  });
});

describe('cmdCache', () => {
  it('reports metadata stats for empty store', () => {
    const metaPath = join(tempDir, 'empty.db');
    new MetadataStore(metaPath).close();

    const logSpy = vi.spyOn(console, 'log');
    cmdCache({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir: tempDir,
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Total files:           0'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Total directories:     0'));
  });

  it('reports file counts with and without file_id', () => {
    const metaPath = join(tempDir, 'meta.db');
    const filePath = join(tempDir, 'note.md');
    writeFileSync(filePath, 'content');

    const meta = new MetadataStore(metaPath);
    meta.setFileInfo(asRelPath('note.md'), {
      fileId: asFileId('f-1'),
      cloudMtime: asEpochSeconds(100),
      localMtime: asEpochSeconds(200),
    });
    meta.setFileInfo(asRelPath('local-only.md'), {
      fileId: asFileId(''),
      cloudMtime: asEpochSeconds(0),
      localMtime: asEpochSeconds(300),
    });
    meta.close();

    const logSpy = vi.spyOn(console, 'log');
    cmdCache({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir: tempDir,
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Total files:           2'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('With file_id:          1'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Without file_id:       1'));
  });

  it('counts file_id but not local', () => {
    const metaPath = join(tempDir, 'meta2.db');
    const meta = new MetadataStore(metaPath);
    meta.setFileInfo(asRelPath('deleted.md'), {
      fileId: asFileId('f-gone'),
      cloudMtime: asEpochSeconds(100),
      localMtime: asEpochSeconds(200),
    });
    meta.close();

    const logSpy = vi.spyOn(console, 'log');
    cmdCache({
      cookiesPath: '',
      metadataPath: metaPath,
      localDir: tempDir,
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('file_id but not local: 1'));
  });
});

function makeCloudSnap(entries: [string, Partial<CloudFile>][]): Map<RelPath, CloudFile> {
  const m = new Map<RelPath, CloudFile>();
  for (const [p, cf] of entries) {
    m.set(asRelPath(p), {
      id: cf.id ?? p,
      name: cf.name ?? p.split('/').pop() ?? p,
      isDir: cf.isDir ?? false,
      mtime: cf.mtime ?? 0,
      ctime: cf.ctime ?? 0,
      parentId: cf.parentId ?? '',
      domain: cf.domain ?? 0,
    } as CloudFile);
  }
  return m;
}

const dummyCfg = { cookiesPath: '', metadataPath: '', localDir: '' };

for (const { name, fn } of [
  { name: 'cmdPath', fn: cmdPath },
  { name: 'cmdDecision', fn: cmdDecision },
]) {
  it(`${name} prints "Specify at least one --target" when no targets`, async () => {
    const logSpy = vi.spyOn(console, 'log');
    await fn(dummyCfg, []);
    expect(logSpy).toHaveBeenCalledWith('Specify at least one --target path');
  });
}

describe('cmdPath', () => {
  const matchCases = [
    {
      name: 'exact match',
      cloud: 'notes/hello.md',
      target: 'notes/hello.md',
      expect: 'Exact match',
    },
    {
      name: 'fuzzy match',
      cloud: 'notes/hello world.md',
      target: 'notes/hello.md',
      expect: 'Fuzzy matches',
    },
    { name: 'not found', cloud: 'other/file.md', target: 'notes/missing.md', expect: 'Not found' },
  ];

  for (const { name, cloud, target, expect: msg } of matchCases) {
    it(`shows "${msg}" for ${name}`, async () => {
      engineMethods.collectItems.mockResolvedValue({
        cloudSnap: makeCloudSnap([[cloud, { name: cloud.split('/').pop()! }]]),
        localSnap: new Map(),
      });

      const logSpy = vi.spyOn(console, 'log');
      await cmdPath(dummyCfg, [target]);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(msg));
    });
  }
});

describe('cmdDecision', () => {
  it('prints decision info for a file', async () => {
    const metaPath = join(tempDir, 'decision.db');
    const meta = new MetadataStore(metaPath);
    meta.setFileInfo(asRelPath('test.md'), {
      fileId: asFileId('f1'),
      cloudMtime: asEpochSeconds(100),
      localMtime: asEpochSeconds(200),
    });
    meta.close();

    engineMethods.collectItems.mockResolvedValue({
      cloudSnap: makeCloudSnap([['test.md', { mtime: asEpochSeconds(100), name: 'test.md' }]]),
      localSnap: new Map([[asRelPath('test.md'), { mtime: asEpochSeconds(200) }]]),
      classified: new Map([[asRelPath('test.md'), { kind: 'synced' }]]),
    });

    const logSpy = vi.spyOn(console, 'log');
    await cmdDecision({ ...dummyCfg, metadataPath: metaPath }, ['test.md']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('File: test.md'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('cloud: exists'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('local: exists'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('classified state: synced'));
  });
});

describe('cmdSummary', () => {
  it('prints dry-run summary with state counts', async () => {
    engineMethods.collectItems.mockResolvedValue({
      classified: new Map([
        [asRelPath('a.md'), { kind: 'synced' }],
        [asRelPath('b.md'), { kind: 'synced' }],
        [asRelPath('c.md'), { kind: 'localNew' }],
      ]),
    });

    const logSpy = vi.spyOn(console, 'log');
    await cmdSummary(dummyCfg);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Dry-run Summary'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('TOTAL'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Non-skip items (1)'));
  });
});

describe('cmdCheckContent', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'check-content-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports no anomalies when all .md files are valid markdown', () => {
    writeFileSync(join(tmpDir, 'good.md'), '# Hello\n\nworld');
    mkdirSync(join(tmpDir, 'sub'));
    writeFileSync(join(tmpDir, 'sub', 'also-good.md'), '## Sub heading');

    const logSpy = vi.spyOn(console, 'log');
    cmdCheckContent(tmpDir);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('All .md files contain valid'));
  });

  it('detects .md files containing raw JSON', () => {
    writeFileSync(join(tmpDir, 'good.md'), '# Normal');
    writeFileSync(join(tmpDir, 'bad.md'), '{"2":"1","5":[]}');

    const logSpy = vi.spyOn(console, 'log');
    cmdCheckContent(tmpDir);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('1 file(s)'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('JSON'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('bad.md'));
  });

  it('detects .md files containing raw XML', () => {
    writeFileSync(join(tmpDir, 'note.md'), '<?xml version="1.0"?><note/>');

    const logSpy = vi.spyOn(console, 'log');
    cmdCheckContent(tmpDir);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('XML'));
  });

  it('ignores non-.md files', () => {
    writeFileSync(join(tmpDir, 'data.json'), '{"key":"value"}');
    writeFileSync(join(tmpDir, 'good.md'), '# Title');

    const logSpy = vi.spyOn(console, 'log');
    cmdCheckContent(tmpDir);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('All .md files contain valid'));
  });
});
