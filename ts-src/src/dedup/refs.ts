import { dirname, join, relative } from 'node:path';
import { readFileSync } from 'node:fs';
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

function extractRefsFromFile(fullPath: string, mdDir: string, root: string): Set<string> {
  const refs = new Set<string>();
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
    const rel = relative(root, abs).replace(/\\/g, '/');
    refs.add(rel);
  }
  return refs;
}

function addRefsFromCache(
  rel: string,
  cachedRefs: ReadonlyMap<string, string[]>,
  referenced: Set<string>,
): void {
  const refs = cachedRefs.get(rel);
  if (refs) for (const ref of refs) referenced.add(ref);
}

function collectRefsFromFile(
  fullPath: string,
  mdDir: string,
  root: string,
  referenced: Set<string>,
): string[] {
  const newRefs = extractRefsFromFile(fullPath, mdDir, root);
  for (const ref of newRefs) referenced.add(ref);
  return [...newRefs];
}

function shouldUseCachedRefs(
  rel: string,
  mtime: number,
  allMeta: ReadonlyMap<string, MetadataRecord>,
  cachedRefs: ReadonlyMap<string, string[]>,
): boolean {
  const cachedMtime = allMeta.get(rel)?.localMtime ?? 0;
  return cachedMtime === mtime && cachedRefs.has(rel);
}

interface ProcessSingleLocalMdFileCtx {
  root: string;
  meta: MetadataStore | undefined;
  allMeta: ReadonlyMap<string, MetadataRecord>;
  cachedRefs: ReadonlyMap<string, string[]>;
  referenced: Set<string>;
}

function processSingleLocalMdFile(
  rel: string,
  info: { path: string; mtime: number; isDir: boolean },
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
  localFiles: Map<string, { path: string; mtime: number; isDir: boolean }>,
  root: string,
  meta: MetadataStore | undefined,
  referenced: Set<string>,
): void {
  const allMeta: ReadonlyMap<string, MetadataRecord> = meta ? meta.getAllFiles() : new Map();
  const cachedRefs = meta ? meta.getAllFileRefs() : new Map<string, string[]>();
  const ctx: ProcessSingleLocalMdFileCtx = { root, meta, allMeta, cachedRefs, referenced };

  for (const [rel, info] of localFiles) {
    processSingleLocalMdFile(rel, info, ctx);
  }
}

function processFullWalk(
  root: string,
  meta: MetadataStore | undefined,
  referenced: Set<string>,
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
  localFiles?: Map<string, { path: string; mtime: number; isDir: boolean }>,
  meta?: MetadataStore,
): Set<string> {
  const referenced = new Set<string>();

  if (localFiles) {
    processLocalMdFiles(localFiles, root, meta, referenced);
  } else {
    processFullWalk(root, meta, referenced);
  }

  return referenced;
}
