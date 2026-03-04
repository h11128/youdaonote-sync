import type { DirId, FileId, NoteDomain } from './common.js';

export interface CloudFile {
  readonly id: FileId | DirId;
  readonly parentId: DirId;
  readonly name: string;
  readonly isDir: boolean;
  readonly mtime: number;
  readonly ctime: number;
  readonly domain: NoteDomain;
}

export interface LocalFile {
  readonly path: string;
  readonly isDir: boolean;
  readonly mtime: number;
  readonly size?: number;
}
