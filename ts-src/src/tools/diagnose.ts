/**
 * Sync diagnostic tool — TS port of tools/debug/diagnose_sync.py
 *
 * Subcommands:
 *   path        - Search for a path in cloud scan results
 *   decision    - Re-run classify for a specific file, show details
 *   summary     - Dry-run summary showing all non-SKIP items
 *   reset-cache - Reset scan cache version to force full cloud scan
 *   cache       - Report metadata cache stats
 *   rebuild     - Rebuild metadata from cloud + local scan
 *   duplicates  - Scan for duplicate files by content hash
 */

import { basename, extname, dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { SyncEngine } from '../engine.js';
import type { RelPath } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import { MetadataStore } from '../metadata/store.js';
import { YoudaoNoteApi } from '../api/client.js';

export { cmdCache, cmdRebuild, cmdDuplicates } from './diagnose-commands.js';

export interface DiagnoseConfig {
  cookiesPath: string;
  metadataPath: string;
  localDir: string;
}

function createEngine(cfg: DiagnoseConfig): SyncEngine {
  return new SyncEngine({
    cookiesPath: cfg.cookiesPath,
    metadataPath: cfg.metadataPath,
    localDir: cfg.localDir,
    dryRun: true,
  });
}

export async function cmdPath(cfg: DiagnoseConfig, targets: string[]): Promise<void> {
  if (targets.length === 0) {
    console.log('Specify at least one --target path');
    return;
  }

  const engine = createEngine(cfg);
  try {
    const { cloudSnap } = await engine.collectItems();

    console.log('='.repeat(70));
    console.log('  Path lookup in cloud scan results');
    console.log('='.repeat(70));

    for (const suspect of targets) {
      printPathLookup(suspect, cloudSnap);
    }

    printExtStats(cloudSnap);
  } finally {
    engine.close();
  }
}

function printPathLookup(suspect: string, cloudSnap: Map<RelPath, CloudFile>): void {
  console.log(`\n  Local path: ${suspect}`);

  const exact = cloudSnap.get(suspect as RelPath);
  if (exact) {
    console.log(`    -> Exact match! name=${exact.name}, isDir=${exact.isDir}`);
    return;
  }

  const nameNoExt = basename(suspect, extname(suspect));
  const fuzzy = [...cloudSnap.entries()].filter(([cp]) => cp.includes(nameNoExt));

  if (fuzzy.length > 0) {
    console.log(`    -> No exact match. Fuzzy matches (${fuzzy.length}):`);
    for (const [cp] of fuzzy.slice(0, 5)) {
      console.log(`      Cloud: ${cp}`);
      if (cp !== suspect) console.log(`        Diff: local=[${suspect}] vs cloud=[${cp}]`);
    }
    return;
  }

  console.log('    -> Not found in cloud scan!');
  const parent = dirname(suspect);
  const children = [...cloudSnap.keys()]
    .filter((p) => p.startsWith(parent + '/') || p === parent)
    .sort();
  console.log(`    -> Parent dir '${parent}' cloud files (${children.length}):`);
  for (const c of children.slice(0, 10)) {
    console.log(`      ${c}`);
  }
  if (children.length > 10) console.log(`      ... and ${children.length - 10} more`);
}

export async function cmdDecision(cfg: DiagnoseConfig, targets: string[]): Promise<void> {
  if (targets.length === 0) {
    console.log('Specify at least one --target path');
    return;
  }

  const engine = createEngine(cfg);
  try {
    const { classified, cloudSnap, localSnap } = await engine.collectItems();
    const meta = new MetadataStore(cfg.metadataPath);

    for (const target of targets) {
      printDecision(target, { cloudSnap, localSnap, classified, meta });
    }

    meta.close();
  } finally {
    engine.close();
  }
}

interface DecisionCtx {
  cloudSnap: Map<RelPath, CloudFile>;
  localSnap: Map<RelPath, { mtime: number }>;
  classified: Map<RelPath, { kind: string }>;
  meta: MetadataStore;
}

function printDecision(target: string, ctx: DecisionCtx): void {
  const { cloudSnap, localSnap, classified, meta } = ctx;
  console.log('\n' + '='.repeat(60));
  console.log(`  File: ${target}`);
  console.log('='.repeat(60));

  const cloud = cloudSnap.get(target as RelPath);
  const local = localSnap.get(target as RelPath);
  const state = classified.get(target as RelPath);
  const fileMeta = meta.getFileInfo(target as RelPath);

  console.log(`  cloud: ${cloud ? 'exists' : 'null'}`);
  if (cloud) console.log(`    mtime=${cloud.mtime}, name=${cloud.name}`);
  console.log(`  local: ${local ? 'exists' : 'null'}`);
  if (local) console.log(`    mtime=${local.mtime}`);
  console.log(`  metadata: ${fileMeta ? JSON.stringify(fileMeta) : 'null'}`);
  console.log(`  classified state: ${state?.kind ?? 'not classified'}`);
}

export async function cmdSummary(cfg: DiagnoseConfig): Promise<void> {
  const engine = createEngine(cfg);
  try {
    const { classified } = await engine.collectItems();

    const counts = new Map<string, number>();
    for (const [, state] of classified) {
      counts.set(state.kind, (counts.get(state.kind) ?? 0) + 1);
    }

    console.log('\n' + '='.repeat(60));
    console.log('  Dry-run Summary');
    console.log('='.repeat(60));

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [kind, count] of sorted) {
      console.log(`  ${kind.padEnd(30)} ${count}`);
    }
    console.log(`  ${'TOTAL'.padEnd(30)} ${classified.size}`);

    const nonSkip = [...classified.entries()].filter(
      ([, s]) => s.kind !== 'synced' && s.kind !== 'cloudModifiedMtimeOnly',
    );

    if (nonSkip.length > 0) {
      console.log(`\n  Non-skip items (${nonSkip.length}):`);
      for (const [path, state] of nonSkip.slice(0, 50)) {
        console.log(`    ${state.kind.padEnd(25)} ${path}`);
      }
      if (nonSkip.length > 50) console.log(`    ... and ${nonSkip.length - 50} more`);
    }
  } finally {
    engine.close();
  }
}

export function cmdResetCache(cfg: DiagnoseConfig): void {
  const meta = new MetadataStore(cfg.metadataPath);
  meta.setState('last_cloud_version', '0');
  meta.setState('last_scan_time', '0');
  console.log('Scan cache version reset to 0. Next sync will do a full cloud scan.');
  meta.close();
}

/**
 * Check API connectivity: login + root dir fetch.
 */
export async function cmdApiStatus(cfg: DiagnoseConfig): Promise<void> {
  const api = new YoudaoNoteApi(cfg.cookiesPath);
  const loginErr = api.loginByCookies();

  console.log('='.repeat(60));
  console.log('  API Status');
  console.log('='.repeat(60));

  if (loginErr) {
    console.log(`  Cookie login: FAILED (${loginErr})`);
    return;
  }
  console.log('  Cookie login: OK');

  try {
    const rootId = await api.getRootId();
    console.log(`  Root dir ID:  ${rootId}`);
    const info = await api.getDirInfoById(rootId);
    const count = info.entries?.length ?? 0;
    console.log(`  Root entries: ${count}`);
    console.log('  API status:   OK');
  } catch (e: unknown) {
    console.log(`  API call:     FAILED (${e instanceof Error ? e.message : String(e)})`);
  }
}

/**
 * Analyze local directory: count non-.md files, images, etc.
 */
export function cmdLocalStats(localDir: string): void {
  console.log('='.repeat(60));
  console.log('  Local file analysis');
  console.log('='.repeat(60));

  const extCount = new Map<string, number>();
  const categories = { md: 0, note: 0, images: 0, other: 0 };

  walkLocal(localDir, '', extCount, categories);

  console.log(`\n  .md files:        ${categories.md}`);
  console.log(`  .note files:      ${categories.note}`);
  console.log(`  images/attach:    ${categories.images}`);
  console.log(`  other files:      ${categories.other}`);
  console.log(`  total non-.md:    ${categories.note + categories.images + categories.other}`);

  console.log('\n  Extension distribution:');
  const sorted = [...extCount.entries()].sort((a, b) => b[1] - a[1]);
  for (const [ext, count] of sorted) {
    console.log(`    ${ext.padEnd(15)} ${count}`);
  }
}

function walkLocal(
  base: string,
  rel: string,
  extCount: Map<string, number>,
  categories: { md: number; note: number; images: number; other: number },
): void {
  const dir = rel ? join(base, rel) : base;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      walkLocal(base, relPath, extCount, categories);
      continue;
    }

    const ext = extname(entry.name).toLowerCase() || '(no ext)';
    extCount.set(ext, (extCount.get(ext) ?? 0) + 1);

    if (ext === '.md') categories.md++;
    else if (ext === '.note') categories.note++;
    else if (relPath.includes('/images/') || relPath.includes('/attachments/')) categories.images++;
    else categories.other++;
  }
}

function printExtStats(cloudSnap: Map<RelPath, CloudFile>): void {
  const extCount = new Map<string, number>();
  for (const [, info] of cloudSnap) {
    if (info.isDir) continue;
    const ext = extname(info.name || '') || '(no extension)';
    extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
  }

  console.log('\n' + '='.repeat(70));
  console.log('  Cloud file extension stats');
  console.log('='.repeat(70));

  const sorted = [...extCount.entries()].sort((a, b) => b[1] - a[1]);
  for (const [ext, count] of sorted) {
    console.log(`  ${ext.padEnd(20)} ${count}`);
  }
}
