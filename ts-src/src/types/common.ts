/**
 * Branded types prevent accidental mixing of string IDs.
 * e.g. passing a FileId where a DirId is expected → compile error.
 */

export type FileId = string & { readonly __brand: 'FileId' };
export type DirId = string & { readonly __brand: 'DirId' };
export type ContentHash = string & { readonly __brand: 'ContentHash' };

export enum NoteDomain {
  NOTE = 0,
  MARKDOWN = 1,
}

export function asFileId(s: string): FileId {
  return s as FileId;
}

export function asDirId(s: string): DirId {
  return s as DirId;
}

export function asContentHash(s: string): ContentHash {
  return s as ContentHash;
}

export type SyncDirection = 'both' | 'pull' | 'push';
