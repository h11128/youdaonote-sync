import { SyncEngine } from '../engine/engine.js';
import { YoudaoNoteApi } from '../api/client.js';
import { MetadataStore } from '../metadata/store.js';
import { asContentHash, NoteDomain, type RelPath } from '../types/common.js';
import type { DiagnoseConfig } from './diagnose.js';

interface ForceReuploadOptions {
  targets: string[];
  marker?: string;
  dryRun?: boolean;
}

interface VerifyNoteOptions {
  targets: string[];
}

interface NoteTableStats {
  topLevelTableBlocks: number;
  topLevelPipeParagraphs: number;
  totalTrNodes: number;
  totalTcNodes: number;
}

interface NoteTableInspectResult {
  status: 'ok' | 'miss' | 'skip' | 'error';
  fileId?: string;
  shape?: 'native-table' | 'pipe-text' | 'no-table';
  stats?: NoteTableStats;
  message?: string;
}

type NoteShape = NonNullable<NoteTableInspectResult['shape']>;

function defaultMarker(prefix: string): string {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}`;
}

function ensureTargets(targets: string[]): boolean {
  if (targets.length > 0) return true;
  console.log('Specify at least one --target path');
  return false;
}

function parseShape(stats: NoteTableStats): NoteShape {
  if (stats.topLevelTableBlocks > 0) return 'native-table';
  if (stats.topLevelPipeParagraphs > 0) return 'pipe-text';
  return 'no-table';
}

function countTextInParagraph(block: Record<string, unknown>): string {
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

function walkTypeCounts(node: Record<string, unknown>, stats: NoteTableStats): void {
  const typeVal = node['6'];
  if (typeVal === 'tr') stats.totalTrNodes++;
  if (typeVal === 'tc') stats.totalTcNodes++;
  const children = Array.isArray(node['5']) ? (node['5'] as unknown[]) : [];
  for (const child of children) {
    if (typeof child === 'object' && child !== null) {
      walkTypeCounts(child as Record<string, unknown>, stats);
    }
  }
}

function countNoteTableStats(doc: unknown): NoteTableStats {
  const stats: NoteTableStats = {
    topLevelTableBlocks: 0,
    topLevelPipeParagraphs: 0,
    totalTrNodes: 0,
    totalTcNodes: 0,
  };
  if (typeof doc !== 'object' || doc === null) return stats;
  const rawBlocks = (doc as Record<string, unknown>)['5'];
  const blocks = (Array.isArray(rawBlocks) ? rawBlocks : []).filter(
    (b): b is Record<string, unknown> => typeof b === 'object' && b !== null,
  );
  for (const block of blocks) {
    if (block['6'] === 't') stats.topLevelTableBlocks++;
    if (block['6'] === undefined) {
      const text = countTextInParagraph(block);
      if (text.trim().startsWith('|') && text.includes('|')) stats.topLevelPipeParagraphs++;
    }
    walkTypeCounts(block, stats);
  }
  return stats;
}

async function inspectNoteTableShape(
  api: YoudaoNoteApi,
  meta: MetadataStore,
  path: RelPath,
): Promise<NoteTableInspectResult> {
  const rec = meta.getFileInfo(path);
  if (!rec?.fileId) return { status: 'miss', message: 'no file_id in metadata' };
  if (rec.domain !== NoteDomain.NOTE) {
    return { status: 'skip', message: `domain=${rec.domain}, not NOTE` };
  }
  try {
    const content = Buffer.from(await api.getFileById(rec.fileId)).toString('utf-8');
    const stats = countNoteTableStats(JSON.parse(content) as unknown);
    return { status: 'ok', fileId: rec.fileId, shape: parseShape(stats), stats };
  } catch (e: unknown) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

function printInspectResult(path: string, result: NoteTableInspectResult): void {
  console.log(`\n- ${path}`);
  if (result.status !== 'ok') {
    const label = result.status.toUpperCase();
    console.log(`  status: ${label} (${result.message})`);
    return;
  }
  const stats = result.stats;
  if (!stats) return;
  console.log(`  fileId: ${result.fileId}`);
  console.log(
    `  shape: ${result.shape} (t=${stats.topLevelTableBlocks}, tr=${stats.totalTrNodes}, tc=${stats.totalTcNodes}, pipe=${stats.topLevelPipeParagraphs})`,
  );
}

function loginApi(cookiesPath: string): YoudaoNoteApi | null {
  const api = new YoudaoNoteApi(cookiesPath);
  const loginErr = api.loginByCookies();
  if (!loginErr) return api;
  console.log(`Cookie login failed: ${loginErr}`);
  process.exitCode = 1;
  return null;
}

export function cmdForceReupload(metadataPath: string, opts: ForceReuploadOptions): void {
  if (!ensureTargets(opts.targets)) return;
  const marker = opts.marker?.trim() ?? defaultMarker('force-reupload');
  const dryRun = opts.dryRun ?? false;
  const meta = new MetadataStore(metadataPath);
  let found = 0;
  let updated = 0;
  console.log('='.repeat(60));
  console.log(`  Force reupload${dryRun ? ' (dry-run)' : ''}`);
  console.log('='.repeat(60));
  console.log(`  Marker: ${marker}`);
  for (const target of opts.targets) {
    const rec = meta.getFileInfo(target as RelPath);
    if (!rec) {
      console.log(`  MISS ${target} (no metadata row)`);
      continue;
    }
    found++;
    const before = meta.getContentHash(target as RelPath);
    if (!dryRun) meta.updateContentHash(target as RelPath, asContentHash(marker));
    const after = dryRun ? marker : (meta.getContentHash(target as RelPath) ?? '(null)');
    console.log(`  OK   ${target}`);
    console.log(`       ${before ?? '(null)'} -> ${after}`);
    updated++;
  }
  console.log(`\n  Targets: ${opts.targets.length}`);
  console.log(`  Found:   ${found}`);
  console.log(`  Updated: ${updated}`);
  meta.close();
}

export async function cmdCheckNoteTables(cfg: DiagnoseConfig, targets: string[]): Promise<void> {
  if (!ensureTargets(targets)) return;
  const api = loginApi(cfg.cookiesPath);
  if (!api) return;
  const meta = new MetadataStore(cfg.metadataPath);
  console.log('='.repeat(60));
  console.log('  NOTE table structure check');
  console.log('='.repeat(60));
  for (const target of targets) {
    const result = await inspectNoteTableShape(api, meta, target as RelPath);
    printInspectResult(target, result);
  }
  meta.close();
}

export async function cmdVerifyNote(cfg: DiagnoseConfig, opts: VerifyNoteOptions): Promise<void> {
  if (!ensureTargets(opts.targets)) return;
  const api = loginApi(cfg.cookiesPath);
  if (!api) return;
  const meta = new MetadataStore(cfg.metadataPath);
  const invalid: string[] = [];
  console.log('='.repeat(60));
  console.log('  Verify NOTE (table shape + push dry-run clean)');
  console.log('='.repeat(60));
  for (const target of opts.targets) {
    const result = await inspectNoteTableShape(api, meta, target as RelPath);
    printInspectResult(target, result);
    if (result.status !== 'ok' || result.shape !== 'native-table') invalid.push(target);
  }
  meta.close();

  const engine = new SyncEngine({
    cookiesPath: cfg.cookiesPath,
    metadataPath: cfg.metadataPath,
    localDir: cfg.localDir,
    dryRun: true,
    direction: 'push',
  });
  const { classified } = await engine.collectItems();
  engine.close();

  const pending = opts.targets
    .map((target) => `${target} => ${classified.get(target as RelPath)?.kind ?? 'missing'}`)
    .filter(
      (entry) => !entry.endsWith('=> synced') && !entry.endsWith('=> cloudModifiedMtimeOnly'),
    );

  console.log('\n' + '-'.repeat(60));
  if (invalid.length === 0 && pending.length === 0) {
    console.log('VERIFY PASS: all targets are native-table and clean in push dry-run.');
    return;
  }
  if (invalid.length > 0) {
    console.log(`VERIFY FAIL: non-native/invalid targets (${invalid.length})`);
    for (const item of invalid) console.log(`  - ${item}`);
  }
  if (pending.length > 0) {
    console.log(`VERIFY FAIL: targets still pending in push dry-run (${pending.length})`);
    for (const item of pending) console.log(`  - ${item}`);
  }
  process.exitCode = 1;
}
