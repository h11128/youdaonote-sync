/**
 * Branded types prevent accidental mixing of semantically distinct primitives.
 * e.g. passing a FileId where a DirId is expected → compile error.
 */

// ── String-branded IDs ──
export type FileId = string & { readonly __brand: 'FileId' };
export type DirId = string & { readonly __brand: 'DirId' };
export type ContentHash = string & { readonly __brand: 'ContentHash' };

// ── Path-branded type ──
export type RelPath = string & { readonly __brand: 'RelPath' };

// ── Time-branded types ──
export type EpochSeconds = number & { readonly __brand: 'EpochSeconds' };
export type EpochMs = number & { readonly __brand: 'EpochMs' };

export enum NoteDomain {
  NOTE = 0,
  MARKDOWN = 1,
}

// ── ID constructors ──
export function asFileId(s: string): FileId {
  return s as FileId;
}

export function asDirId(s: string): DirId {
  return s as DirId;
}

export function asContentHash(s: string): ContentHash {
  return s as ContentHash;
}

// ── Path constructors ──
export function asRelPath(s: string): RelPath {
  return s as RelPath;
}

export function joinRelPath(base: RelPath | '', segment: string): RelPath {
  return (base ? `${base}/${segment}` : segment) as RelPath;
}

// ── Time constructors ──
export function asEpochSeconds(n: number): EpochSeconds {
  return n as EpochSeconds;
}

export function asEpochMs(n: number): EpochMs {
  return n as EpochMs;
}

export function nowSeconds(): EpochSeconds {
  return Math.floor(Date.now() / 1000) as EpochSeconds;
}

export function nowMs(): EpochMs {
  return Date.now() as EpochMs;
}

export function msToSeconds(ms: EpochMs): EpochSeconds {
  return Math.floor((ms as number) / 1000) as EpochSeconds;
}

export type SyncDirection = 'both' | 'pull' | 'push';
