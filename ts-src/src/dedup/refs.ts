import { dirname, join, relative } from 'node:path';
import { readFileSync } from 'node:fs';
import type { MetadataRecord } from '../types/metadata.js';
import type { MetadataStore } from '../metadata/store.js';
import { walkFiles } from './walk.js';

const MD_REF_RE = /!?\[[^\]]*\]\(([^)]+)\)|src="([^"]+)"/g;

function extractRefsFromFile(fullPath: string, mdDir: string, root: string): Set<string> {
  const refs = new Set<string>();
  let content: string;
  try { content = readFileSync(fullPath, 'utf-8'); } catch { return refs; }

  for (const m of content.matchAll(MD_REF_RE)) {
    const refPath = m[1] ?? m[2];
    if (!refPath) continue;
    if (/^(https?:|data:|note:|ftp:|mailto:|\/\/)/.test(refPath)) continue;

    const abs = join(mdDir, refPath);
    const rel = relative(root, abs).replace(/\\/g, '/');
    refs.add(rel);
  }
  return refs;
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
    const allMeta: ReadonlyMap<string, MetadataRecord> = meta ? meta.getAllFiles() : new Map();
    const cachedRefs = meta ? meta.getAllFileRefs() : new Map<string, string[]>();

    for (const [rel, info] of localFiles) {
      if (info.isDir || !rel.endsWith('.md')) continue;

      const cachedMtime = allMeta.get(rel)?.localMtime ?? 0;
      if (cachedMtime === info.mtime && cachedRefs.has(rel)) {
        for (const ref of cachedRefs.get(rel)!) referenced.add(ref);
      } else {
        const newRefs = extractRefsFromFile(info.path, dirname(info.path), root);
        for (const ref of newRefs) referenced.add(ref);
        if (meta) meta.setFileRefs(rel, [...newRefs]);
      }
    }
  } else {
    walkFiles(root, root, (entry) => {
      if (!entry.isMd) return;
      for (const ref of extractRefsFromFile(entry.absPath, dirname(entry.absPath), root)) {
        referenced.add(ref);
      }
    });
  }

  return referenced;
}
