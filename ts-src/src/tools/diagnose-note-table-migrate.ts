import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { YoudaoNoteApi } from '../api/client.js';
import { MetadataStore } from '../metadata/store.js';
import { asContentHash, NoteDomain, type RelPath } from '../types/common.js';
import type { DiagnoseConfig } from './diagnose.js';

interface MigrateNoteTablesOptions {
  dryRun?: boolean;
  filter?: string;
  limit?: number;
  marker?: string;
}

interface NoteShapeResult {
  status: 'ok' | 'skip' | 'error';
  shape?: 'native-table' | 'pipe-text' | 'no-table';
}

function defaultMarker(prefix: string): string {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}`;
}

function hasMarkdownTable(content: string): boolean {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]?.trim() ?? '';
    const next = lines[i + 1]?.trim() ?? '';
    if (line.startsWith('|') && line.endsWith('|') && /^\|[\s\-:|]+\|$/.test(next)) return true;
  }
  return false;
}

function shouldScanAsCandidate(path: string, filter: string | undefined): boolean {
  if (!path.toLowerCase().endsWith('.md')) return false;
  return !filter || path.startsWith(filter);
}

function loginApi(cookiesPath: string): YoudaoNoteApi | null {
  const api = new YoudaoNoteApi(cookiesPath);
  const loginErr = api.loginByCookies();
  if (!loginErr) return api;
  console.log(`Cookie login failed: ${loginErr}`);
  process.exitCode = 1;
  return null;
}

function getNoteTableCandidates(
  meta: MetadataStore,
  localDir: string,
  filter: string | undefined,
): RelPath[] {
  const allFiles = [...meta.getAllFiles().entries()]
    .map(([path, rec]) => ({ path, rec }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return allFiles
    .filter(
      ({ path, rec }) =>
        rec.domain === NoteDomain.NOTE && rec.fileId && shouldScanAsCandidate(path, filter),
    )
    .filter(({ path }) => existsSync(join(localDir, path)))
    .filter(({ path }) => hasMarkdownTable(readFileSync(join(localDir, path), 'utf-8')))
    .map(({ path }) => path);
}

function parseShapeStats(doc: unknown): 'native-table' | 'pipe-text' | 'no-table' {
  if (typeof doc !== 'object' || doc === null) return 'no-table';
  const blocks = Array.isArray((doc as Record<string, unknown>)['5'])
    ? ((doc as Record<string, unknown>)['5'] as unknown[])
    : [];
  let hasTable = false;
  let hasPipe = false;
  for (const blockNode of blocks) {
    if (typeof blockNode !== 'object' || blockNode === null) continue;
    const block = blockNode as Record<string, unknown>;
    if (block['6'] === 't') hasTable = true;
    if (block['6'] !== undefined) continue;
    const text = readParagraphText(block);
    if (text.trim().startsWith('|') && text.includes('|')) hasPipe = true;
  }
  if (hasTable) return 'native-table';
  if (hasPipe) return 'pipe-text';
  return 'no-table';
}

function readParagraphText(block: Record<string, unknown>): string {
  const children = Array.isArray(block['5']) ? (block['5'] as unknown[]) : [];
  return children
    .flatMap((childNode) => {
      if (typeof childNode !== 'object' || childNode === null) return [];
      const child = childNode as Record<string, unknown>;
      const spans = Array.isArray(child['7']) ? (child['7'] as unknown[]) : [];
      return spans.flatMap((spanNode) => {
        if (typeof spanNode !== 'object' || spanNode === null) return [];
        const span = spanNode as Record<string, unknown>;
        return typeof span['8'] === 'string' ? [span['8']] : [];
      });
    })
    .join('');
}

async function inspectShape(
  api: YoudaoNoteApi,
  meta: MetadataStore,
  path: RelPath,
): Promise<NoteShapeResult> {
  const rec = meta.getFileInfo(path);
  if (!rec?.fileId || rec.domain !== NoteDomain.NOTE) return { status: 'skip' };
  try {
    const content = Buffer.from(await api.getFileById(rec.fileId)).toString('utf-8');
    const shape = parseShapeStats(JSON.parse(content) as unknown);
    return { status: 'ok', shape };
  } catch {
    return { status: 'error' };
  }
}

async function collectPipeTextTargets(
  api: YoudaoNoteApi,
  meta: MetadataStore,
  candidates: RelPath[],
  limit: number,
): Promise<RelPath[]> {
  const toMigrate: RelPath[] = [];
  for (const path of candidates) {
    const result = await inspectShape(api, meta, path);
    if (result.status !== 'ok' || result.shape !== 'pipe-text') continue;
    toMigrate.push(path);
    if (limit > 0 && toMigrate.length >= limit) break;
  }
  return toMigrate;
}

export async function cmdMigrateNoteTables(
  cfg: DiagnoseConfig,
  opts: MigrateNoteTablesOptions,
): Promise<void> {
  const api = loginApi(cfg.cookiesPath);
  if (!api) return;
  const dryRun = opts.dryRun ?? false;
  const limit = opts.limit ?? 0;
  const marker = opts.marker?.trim() ?? defaultMarker('force-reupload-native-table');
  const meta = new MetadataStore(cfg.metadataPath);
  const candidates = getNoteTableCandidates(meta, cfg.localDir, opts.filter);
  const toMigrate = await collectPipeTextTargets(api, meta, candidates, limit);
  console.log('='.repeat(60));
  console.log(`  Migrate NOTE tables${dryRun ? ' (dry-run)' : ''}`);
  console.log('='.repeat(60));
  console.log(`  Candidate NOTE markdown files: ${candidates.length}`);
  console.log(`  Pipe-text files to migrate:    ${toMigrate.length}`);
  if (dryRun || toMigrate.length === 0) {
    for (const path of toMigrate) console.log(`  - ${path}`);
    meta.close();
    return;
  }
  console.log(`  Marker: ${marker}`);
  for (const path of toMigrate) {
    const before = meta.getContentHash(path);
    meta.updateContentHash(path, asContentHash(marker));
    const after = meta.getContentHash(path);
    console.log(`  OK   ${path}`);
    console.log(`       ${before ?? '(null)'} -> ${after ?? '(null)'}`);
  }
  meta.close();
  console.log('\n  Next step: run `npx youdaonote-sync sync --push`');
}
