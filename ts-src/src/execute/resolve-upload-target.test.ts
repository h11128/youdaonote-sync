import { describe, expect, it } from 'vitest';
import { asDirId, asEpochSeconds, asFileId, NoteDomain } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import { resolveUploadMeta } from './resolve-upload-target.js';

function cloud(overrides: Partial<CloudFile> = {}): CloudFile {
  return {
    id: asFileId('WEB-note'),
    parentId: asDirId('dir'),
    name: '2026年8月13日.note',
    isDir: false,
    mtime: asEpochSeconds(1),
    ctime: asEpochSeconds(1),
    domain: NoteDomain.NOTE,
    ...overrides,
  };
}

describe('resolveUploadMeta', () => {
  it('uses scanned cloud id/name/domain when metadata is missing', () => {
    expect(resolveUploadMeta(undefined, cloud())).toEqual({
      fileId: asFileId('WEB-note'),
      domain: NoteDomain.NOTE,
      name: '2026年8月13日.note',
    });
  });

  it('prefers scanned cloud over empty or stale metadata file_id', () => {
    const stale = { fileId: asFileId('WEB-old-md'), domain: NoteDomain.MARKDOWN };
    expect(resolveUploadMeta(stale, cloud())).toEqual({
      fileId: asFileId('WEB-note'),
      domain: NoteDomain.NOTE,
      name: '2026年8月13日.note',
    });
    expect(
      resolveUploadMeta({ fileId: '' as never, domain: NoteDomain.MARKDOWN }, cloud())?.fileId,
    ).toBe(asFileId('WEB-note'));
  });

  it('falls back to metadata only when this snapshot has no cloud file', () => {
    expect(
      resolveUploadMeta({ fileId: asFileId('meta-id'), domain: NoteDomain.MARKDOWN }, undefined),
    ).toEqual({
      fileId: asFileId('meta-id'),
      domain: NoteDomain.MARKDOWN,
    });
  });

  it('returns undefined when neither side has a target', () => {
    expect(resolveUploadMeta(undefined, undefined)).toBeUndefined();
    expect(resolveUploadMeta({ fileId: '' as never }, undefined)).toBeUndefined();
  });
});
