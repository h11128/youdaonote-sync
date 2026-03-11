import { dirname, join, relative } from 'node:path';
import { readFileSync } from 'node:fs';
import { asRelPath, type EpochSeconds, type RelPath } from '../types/common.js';
import type { MetadataRecord } from '../types/metadata.js';
import type { MetadataStore } from '../metadata/store.js';
import { walkFiles } from './walk.js';

const MD_REF_RE = /!?\[[^\]]*\]\(([^)]+)\)|src="([^"]+)"/g;

function isExternalOrAbsoluteRef(refPath: string): boolean {
  if (/^(https?:|data:|note:|ftp:|mailto:|\/\/|\\\\)/.test(refPath)) return true;
  if (refPath.includes('://')) return true;
  if (refPath.length > 2 && refPath[2] === ':') return true;
  return false;
}

function extractRefsFromFile(fullPath: string, mdDir: string, root: string): Set<RelPath> {
  const refs = new Set<RelPath>();
  let content: string;
  try {
    content = readFileSync(fullPath, 'utf-8');
  } catch {
    return refs;
  }

  for (const m of content.matchAll(MD_REF_RE)) {
    const refPath = m[1] ?? m[2];
    if (!refPath || isExternalOrAbsoluteRef(refPath)) continue;

    const abs = join(mdDir, refPath);
    const rel = asRelPath(relative(root, abs).replace(/\\/g, '/'));
    refs.add(rel);
  }
  return refs;
}

function addRefsFromCache(
  rel: RelPath,
  cachedRefs: ReadonlyMap<RelPath, RelPath[]>,
  referenced: Set<RelPath>,
): void {
  const refs = cachedRefs.get(rel);
  if (refs) for (const ref of refs) referenced.add(ref);
}

function collectRefsFromFile(
  fullPath: string,
  mdDir: string,
  root: string,
  referenced: Set<RelPath>,
): RelPath[] {
  const newRefs = extractRefsFromFile(fullPath, mdDir, root);
  for (const ref of newRefs) referenced.add(ref);
  return [...newRefs];
}

function shouldUseCachedRefs(
  rel: RelPath,
  mtime: EpochSeconds,
  allMeta: ReadonlyMap<RelPath, MetadataRecord>,
  cachedRefs: ReadonlyMap<RelPath, RelPath[]>,
): boolean {
  const cachedMtime = allMeta.get(rel)?.localMtime ?? (0 as EpochSeconds);
  return cachedMtime === mtime && cachedRefs.has(rel);
}

interface ProcessSingleLocalMdFileCtx {
  root: string;
  meta: MetadataStore | undefined;
  allMeta: ReadonlyMap<RelPath, MetadataRecord>;
  cachedRefs: ReadonlyMap<RelPath, RelPath[]>;
  referenced: Set<RelPath>;
}

function processSingleLocalMdFile(
  rel: RelPath,
  info: { path: string; mtime: EpochSeconds; isDir: boolean },
  ctx: ProcessSingleLocalMdFileCtx,
): void {
  if (info.isDir || !rel.endsWith('.md')) return;

  if (shouldUseCachedRefs(rel, info.mtime, ctx.allMeta, ctx.cachedRefs)) {
    addRefsFromCache(rel, ctx.cachedRefs, ctx.referenced);
  } else {
    const newRefs = collectRefsFromFile(info.path, dirname(info.path), ctx.root, ctx.referenced);
    if (ctx.meta) ctx.meta.setFileRefs(rel, newRefs);
  }
}

function processLocalMdFiles(
  localFiles: Map<RelPath, { path: string; mtime: EpochSeconds; isDir: boolean }>,
  root: string,
  meta: MetadataStore | undefined,
  referenced: Set<RelPath>,
): void {
  const allMeta: ReadonlyMap<RelPath, MetadataRecord> = meta ? meta.getAllFiles() : new Map();
  const cachedRefs = meta
    ? (meta.getAllFileRefs() as Map<RelPath, RelPath[]>)
    : new Map<RelPath, RelPath[]>();
  const ctx: ProcessSingleLocalMdFileCtx = { root, meta, allMeta, cachedRefs, referenced };

  for (const [rel, info] of localFiles) {
    processSingleLocalMdFile(rel, info, ctx);
  }
}

function processFullWalk(
  root: string,
  meta: MetadataStore | undefined,
  referenced: Set<RelPath>,
): void {
  walkFiles(root, root, (entry) => {
    if (!entry.isMd) return;
    const newRefs = collectRefsFromFile(entry.absPath, dirname(entry.absPath), root, referenced);
    if (meta) meta.setFileRefs(entry.rel, newRefs);
  });
}

/**
 * Build the set of all asset paths referenced by .md files.
 *
 * With localFiles + meta: uses cached refs for unchanged files (incremental).
 * Without: falls back to full filesystem walk.
 */
export function buildRefIndex(
  root: string,
  localFiles?: Map<RelPath, { path: string; mtime: EpochSeconds; isDir: boolean }>,
  meta?: MetadataStore,
): Set<RelPath> {
  const referenced = new Set<RelPath>();

  if (localFiles) {
    processLocalMdFiles(localFiles, root, meta, referenced);
  } else {
    processFullWalk(root, meta, referenced);
  }

  return referenced;
}
