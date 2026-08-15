import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetadataStore } from '../metadata/store.js';
import {
  asDirId,
  asEpochSeconds,
  asFileId,
  asRelPath,
  NoteDomain,
  type RelPath,
} from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import { hydrateLocalOnlyFromParents } from './hydrate-cached-cloud.js';

const TMP = join(tmpdir(), 'hydrate-cache-test');

function noteFile(id: string, name: string, parentId: string, isDir = false): CloudFile {
  return {
    id: isDir ? asDirId(id) : asFileId(id),
    parentId: asDirId(parentId),
    name,
    isDir,
    mtime: asEpochSeconds(1),
    ctime: asEpochSeconds(1),
    domain: NoteDomain.NOTE,
  };
}

function localMd(rel: string): [RelPath, LocalFile] {
  const path = asRelPath(rel);
  return [path, { path: join(TMP, rel), mtime: asEpochSeconds(1), size: 1, isDir: false }];
}

function listingById(
  dirs: Record<string, { id: string; name: string; dir?: boolean; domain?: number }[]>,
) {
  return {
    getDirInfoById: (id: string) =>
      Promise.resolve({
        entries: (dirs[id] ?? []).map((e) => ({
          fileEntry: {
            id: e.id,
            name: e.name,
            dir: e.dir ?? false,
            ...(e.domain != null ? { domain: e.domain } : {}),
          },
        })),
      }),
  };
}

let meta: MetadataStore;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  meta = new MetadataStore(join(TMP, 'meta.db'));
});

afterEach(() => {
  meta.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe('hydrateLocalOnlyFromParents', () => {
  it('lists the parent and binds a local .md to the official-app .note', async () => {
    meta.setDirInfo(asRelPath('日记'), asDirId('dir-diary'), asDirId('root'));
    const localSnap = new Map<RelPath, LocalFile>([
      [
        asRelPath('日记/2026年8月13日.md'),
        {
          path: join(TMP, '日记/2026年8月13日.md'),
          mtime: asEpochSeconds(10),
          size: 4,
          isDir: false,
        },
      ],
    ]);
    const cloudSnap = new Map<RelPath, CloudFile>();
    const api = listingById({
      root: [{ id: 'dir-diary', name: '日记', dir: true }],
      'dir-diary': [
        { id: 'WEB-note', name: '2026年8月13日.note', domain: 0 },
        { id: 'WEB-md', name: '2026年8月13日.md', domain: 1 },
      ],
    });

    const n = await hydrateLocalOnlyFromParents({
      api,
      meta,
      cloudSnap,
      localSnap,
      rootDirId: asDirId('root'),
    });

    expect(n.merged).toBeGreaterThan(0);
    expect(n.blocked).toBe(0);
    const hit = cloudSnap.get(asRelPath('日记/2026年8月13日.md'));
    expect(hit?.id).toBe('WEB-note');
    expect(hit?.name).toBe('2026年8月13日.note');
    expect(hit?.domain).toBe(NoteDomain.NOTE);
    expect(meta.getFileInfo(asRelPath('日记/2026年8月13日.md'))?.fileId).toBe('WEB-note');
  });

  it('does not list when the local path is already in the snap', async () => {
    const rel = asRelPath('doc.md');
    const cloudSnap = new Map<RelPath, CloudFile>([
      [
        rel,
        {
          id: asFileId('already'),
          parentId: asDirId('root'),
          name: 'doc.note',
          isDir: false,
          mtime: asEpochSeconds(1),
          ctime: asEpochSeconds(1),
          domain: NoteDomain.NOTE,
        },
      ],
    ]);
    let listed = 0;
    await hydrateLocalOnlyFromParents({
      api: {
        getDirInfoById: () => {
          listed++;
          return Promise.resolve({ entries: [] });
        },
      },
      meta,
      cloudSnap,
      localSnap: new Map([
        [rel, { path: join(TMP, 'doc.md'), mtime: asEpochSeconds(1), size: 1, isDir: false }],
      ]),
      rootDirId: asDirId('root'),
    });
    expect(listed).toBe(0);
    expect(cloudSnap.get(rel)?.id).toBe('already');
  });
});

describe('hydrateLocalOnlyFromParents: fail-closed', () => {
  it('counts blocked and warns when parent list fails', async () => {
    meta.setDirInfo(asRelPath('日记'), asDirId('dir-diary'), asDirId('root'));
    const result = await hydrateLocalOnlyFromParents({
      api: { getDirInfoById: () => Promise.reject(new Error('network')) },
      meta,
      cloudSnap: new Map(),
      localSnap: new Map([localMd('日记/day.md')]),
      rootDirId: asDirId('root'),
    });
    expect(result.blocked).toBe(1);
    expect(result.merged).toBe(0);
  });

  it('does not import unrelated siblings from the parent listing', async () => {
    meta.setDirInfo(asRelPath('日记'), asDirId('dir-diary'), asDirId('root'));
    const cloudSnap = new Map<RelPath, CloudFile>();
    await hydrateLocalOnlyFromParents({
      api: listingById({
        root: [{ id: 'dir-diary', name: '日记', dir: true }],
        'dir-diary': [
          { id: 'WEB-note', name: 'day.note', domain: 0 },
          { id: 'WEB-db', name: 'skip.db', domain: 1 },
        ],
      }),
      meta,
      cloudSnap,
      localSnap: new Map([localMd('日记/day.md')]),
      rootDirId: asDirId('root'),
    });
    expect(cloudSnap.has(asRelPath('日记/day.md'))).toBe(true);
    expect(cloudSnap.has(asRelPath('日记/skip.db'))).toBe(false);
  });

  it('uses a directory entry already in the snap when metadata has no dir id', async () => {
    const listedIds: string[] = [];
    const cloudSnap = new Map<RelPath, CloudFile>([
      [asRelPath('日记'), noteFile('dir-from-snap', '日记', 'root', true)],
    ]);
    const inner = listingById({
      root: [{ id: 'dir-from-snap', name: '日记', dir: true }],
      'dir-from-snap': [{ id: 'WEB-note', name: 'day.note', domain: 0 }],
    });
    const result = await hydrateLocalOnlyFromParents({
      api: {
        getDirInfoById: (id) => {
          listedIds.push(String(id));
          return inner.getDirInfoById(id);
        },
      },
      meta,
      cloudSnap,
      localSnap: new Map([localMd('日记/day.md')]),
      rootDirId: asDirId('root'),
    });
    expect(listedIds[0]).toBe('dir-from-snap');
    expect(result.blocked).toBe(0);
    expect(cloudSnap.get(asRelPath('日记/day.md'))?.id).toBe('WEB-note');
  });
});

describe('hydrateLocalOnlyFromParents: sibling listing gate', () => {
  it('blocks when the listing misses known siblings (stale dir id)', async () => {
    meta.setDirInfo(asRelPath('日记'), asDirId('dir-stale'), asDirId('root'));
    const cloudSnap = new Map<RelPath, CloudFile>([
      [asRelPath('日记/other.md'), noteFile('known-sib', 'other.note', 'dir-stale')],
    ]);
    const result = await hydrateLocalOnlyFromParents({
      api: {
        getDirInfoById: () =>
          Promise.resolve({
            entries: [{ fileEntry: { id: 'WEB-unrelated', name: 'unrelated.note', domain: 0 } }],
          }),
      },
      meta,
      cloudSnap,
      localSnap: new Map([localMd('日记/day.md')]),
      rootDirId: asDirId('root'),
    });
    expect(result.blocked).toBe(1);
    expect(result.merged).toBe(0);
    expect(cloudSnap.has(asRelPath('日记/day.md'))).toBe(false);
  });

  it('merges the wanted .note when the listing also contains a known sibling', async () => {
    meta.setDirInfo(asRelPath('日记'), asDirId('dir-diary'), asDirId('root'));
    const cloudSnap = new Map<RelPath, CloudFile>([
      [asRelPath('日记/other.md'), noteFile('known-sib', 'other.note', 'dir-diary')],
    ]);
    const result = await hydrateLocalOnlyFromParents({
      api: {
        getDirInfoById: () =>
          Promise.resolve({
            entries: [
              { fileEntry: { id: 'known-sib', name: 'other.note', domain: 0 } },
              { fileEntry: { id: 'WEB-note', name: 'day.note', domain: 0 } },
            ],
          }),
      },
      meta,
      cloudSnap,
      localSnap: new Map([localMd('日记/day.md')]),
      rootDirId: asDirId('root'),
    });
    expect(result.blocked).toBe(0);
    expect(result.merged).toBeGreaterThanOrEqual(1);
    expect(cloudSnap.get(asRelPath('日记/day.md'))?.id).toBe('WEB-note');
  });

  it('does not block a true local-new file when known siblings appear in the listing', async () => {
    meta.setDirInfo(asRelPath('日记'), asDirId('dir-diary'), asDirId('root'));
    const cloudSnap = new Map<RelPath, CloudFile>([
      [asRelPath('日记/other.md'), noteFile('known-sib', 'other.note', 'dir-diary')],
    ]);
    const result = await hydrateLocalOnlyFromParents({
      api: {
        getDirInfoById: () =>
          Promise.resolve({
            entries: [{ fileEntry: { id: 'known-sib', name: 'other.note', domain: 0 } }],
          }),
      },
      meta,
      cloudSnap,
      localSnap: new Map([localMd('日记/new.md')]),
      rootDirId: asDirId('root'),
    });
    expect(result.blocked).toBe(0);
    expect(result.merged).toBe(0);
    expect(cloudSnap.has(asRelPath('日记/new.md'))).toBe(false);
  });
});

describe('hydrateLocalOnlyFromParents: walk confirm', () => {
  it('blocks a stale dir id when the cache has no siblings', async () => {
    meta.setDirInfo(asRelPath('日记'), asDirId('dir-stale'), asDirId('root'));
    const cloudSnap = new Map<RelPath, CloudFile>();
    const result = await hydrateLocalOnlyFromParents({
      api: listingById({
        root: [{ id: 'dir-real', name: '日记', dir: true }],
        'dir-stale': [{ id: 'WEB-wrong', name: 'day.note', domain: 0 }],
        'dir-real': [{ id: 'WEB-note', name: 'day.note', domain: 0 }],
      }),
      meta,
      cloudSnap,
      localSnap: new Map([localMd('日记/day.md')]),
      rootDirId: asDirId('root'),
    });
    expect(result.blocked).toBe(1);
    expect(result.merged).toBe(0);
    expect(cloudSnap.has(asRelPath('日记/day.md'))).toBe(false);
  });
});
