import type { DirId, EpochSeconds, FileId, NoteDomain } from './common.js';

export interface CloudFile {
  readonly id: FileId | DirId;
  readonly parentId: DirId;
  readonly name: string;
  readonly isDir: boolean;
  readonly mtime: EpochSeconds;
  readonly ctime: EpochSeconds;
  readonly domain: NoteDomain;
}

export interface LocalFile {
  readonly path: string;
  readonly isDir: boolean;
  readonly mtime: EpochSeconds;
  readonly size?: number;
}
