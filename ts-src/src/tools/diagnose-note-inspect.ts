import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { convertToMarkdown, detectFileType } from '../execute/download.js';
import { YoudaoNoteApi } from '../api/client.js';
import { MetadataStore } from '../metadata/store.js';
import type { RelPath } from '../types/common.js';
import type { DiagnoseConfig } from './diagnose.js';

interface FetchNoteOptions {
  target: string;
  output?: string;
  raw?: boolean;
}

interface CompareNoteOptions {
  a: string;
  b: string;
  focus?: 'table' | 'attrs' | 'raw';
}

interface CompareCloudLocalOptions {
  target: string;
  maxDiffs?: number;
}

interface ResolvedNote {
  path: string;
  fileId: string;
  text: string;
  parsed: unknown;
}

interface TableContractStats {
  topLevelTableBlocks: number;
  topLevelPipeParagraphs: number;
  totalTrNodes: number;
  totalTcNodes: number;
  missingTableAttrs: string[];
}

function loginApi(cookiesPath: string): YoudaoNoteApi | null {
  const api = new YoudaoNoteApi(cookiesPath);
  const loginErr = api.loginByCookies();
  if (!loginErr) return api;
  console.log(`Cookie login failed: ${loginErr}`);
  process.exitCode = 1;
  return null;
}

function countParagraphText(node: Record<string, unknown>): string {
  const children = Array.isArray(node['5']) ? (node['5'] as unknown[]) : [];
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

function walkTypeCounts(node: Record<string, unknown>, stats: TableContractStats): void {
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

function checkMissingTableAttrs(tableBlock: Record<string, unknown>): string[] {
  const attrs = tableBlock['4'];
  if (typeof attrs !== 'object' || attrs === null) return ['version', 'cw', 'rh'];
  const record = attrs as Record<string, unknown>;
  const missing: string[] = [];
  if (record.version === undefined) missing.push('version');
  if (!Array.isArray(record.cw)) missing.push('cw');
  if (!Array.isArray(record.rh)) missing.push('rh');
  return missing;
}

function getTableContractStats(doc: unknown): TableContractStats {
  const stats: TableContractStats = {
    topLevelTableBlocks: 0,
    topLevelPipeParagraphs: 0,
    totalTrNodes: 0,
    totalTcNodes: 0,
    missingTableAttrs: [],
  };
  if (typeof doc !== 'object' || doc === null) return stats;
  const root = doc as Record<string, unknown>;
  const blocks = Array.isArray(root['5']) ? (root['5'] as unknown[]) : [];
  for (const node of blocks) {
    if (typeof node !== 'object' || node === null) continue;
    const block = node as Record<string, unknown>;
    if (block['6'] === 't') {
      stats.topLevelTableBlocks++;
      stats.missingTableAttrs.push(...checkMissingTableAttrs(block));
    }
    if (block['6'] === undefined) {
      const text = countParagraphText(block);
      if (text.trim().startsWith('|') && text.includes('|')) stats.topLevelPipeParagraphs++;
    }
    walkTypeCounts(block, stats);
  }
  stats.missingTableAttrs = [...new Set(stats.missingTableAttrs)];
  return stats;
}

async function resolveNoteByPath(
  api: YoudaoNoteApi,
  meta: MetadataStore,
  target: string,
): Promise<ResolvedNote | null> {
  const rec = meta.getFileInfo(target as RelPath);
  if (!rec?.fileId) {
    console.log(`MISS ${target}: no file_id in metadata`);
    return null;
  }
  try {
    const buf = await api.getFileById(rec.fileId);
    return {
      path: target,
      fileId: rec.fileId,
      text: Buffer.from(buf).toString('utf-8'),
      parsed: tryParseJson(new Uint8Array(buf)),
    };
  } catch (e: unknown) {
    console.log(`ERROR ${target}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function tryParseJson(buf: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(buf).toString('utf-8')) as unknown;
  } catch {
    return null;
  }
}

function printRawDiff(a: string, b: string): void {
  if (a === b) {
    console.log('  raw: identical');
    return;
  }
  const min = Math.min(a.length, b.length);
  let diffPos = -1;
  for (let i = 0; i < min; i++) {
    if (a[i] !== b[i]) {
      diffPos = i;
      break;
    }
  }
  if (diffPos < 0) diffPos = min;
  console.log(`  raw: differs at char ${diffPos}, len(a)=${a.length}, len(b)=${b.length}`);
}

function printTopAttrsDiff(a: unknown, b: unknown): void {
  const ao = typeof a === 'object' && a !== null ? (a as Record<string, unknown>) : {};
  const bo = typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
  const keys = ['2', '4', '__compress__', 'title'];
  for (const key of keys) {
    const av = JSON.stringify(ao[key]);
    const bv = JSON.stringify(bo[key]);
    console.log(av === bv ? `  ${key}: same` : `  ${key}: different`);
  }
}

function printLineDiff(localMd: string, cloudMd: string, maxDiffs: number): void {
  const localLines = localMd.split('\n');
  const cloudLines = cloudMd.split('\n');
  const total = Math.max(localLines.length, cloudLines.length);
  let shown = 0;
  for (let i = 0; i < total && shown < maxDiffs; i++) {
    const l = localLines[i] ?? '(missing)';
    const c = cloudLines[i] ?? '(missing)';
    if (l === c) continue;
    shown++;
    console.log(`  line ${i + 1}`);
    console.log(`    local: ${JSON.stringify(l).slice(0, 180)}`);
    console.log(`    cloud: ${JSON.stringify(c).slice(0, 180)}`);
  }
  if (shown === 0) console.log('  line diff: none (possible trailing newline only)');
}

export async function cmdFetchNote(cfg: DiagnoseConfig, opts: FetchNoteOptions): Promise<void> {
  const api = loginApi(cfg.cookiesPath);
  if (!api) return;
  const meta = new MetadataStore(cfg.metadataPath);
  const note = await resolveNoteByPath(api, meta, opts.target);
  meta.close();
  if (!note) return;
  console.log('='.repeat(60));
  console.log(`  Fetch NOTE: ${note.path}`);
  console.log('='.repeat(60));
  console.log(`  fileId: ${note.fileId}`);
  if (note.parsed) {
    const stats = getTableContractStats(note.parsed);
    console.log(
      `  shape stats: t=${stats.topLevelTableBlocks}, tr=${stats.totalTrNodes}, tc=${stats.totalTcNodes}, pipe=${stats.topLevelPipeParagraphs}`,
    );
    if (stats.missingTableAttrs.length > 0) {
      console.log(`  missing table attrs: ${stats.missingTableAttrs.join(', ')}`);
    }
  } else {
    console.log('  parsed: not JSON');
  }
  if (!opts.output) return;
  const outPath = join(cfg.localDir, opts.output);
  mkdirSync(dirname(outPath), { recursive: true });
  if (opts.raw || !note.parsed) {
    writeFileSync(outPath, note.text, 'utf-8');
  } else {
    writeFileSync(outPath, JSON.stringify(note.parsed, null, 2), 'utf-8');
  }
  console.log(`  saved: ${outPath}`);
}

export async function cmdCompareNote(cfg: DiagnoseConfig, opts: CompareNoteOptions): Promise<void> {
  const api = loginApi(cfg.cookiesPath);
  if (!api) return;
  const meta = new MetadataStore(cfg.metadataPath);
  const a = await resolveNoteByPath(api, meta, opts.a);
  const b = await resolveNoteByPath(api, meta, opts.b);
  meta.close();
  if (!a || !b) return;
  console.log('='.repeat(60));
  console.log(`  Compare NOTE: A=${a.path} | B=${b.path}`);
  console.log('='.repeat(60));
  if (opts.focus === 'raw') {
    printRawDiff(a.text, b.text);
    return;
  }
  if (opts.focus === 'attrs') {
    printTopAttrsDiff(a.parsed, b.parsed);
    return;
  }
  const sa = getTableContractStats(a.parsed);
  const sb = getTableContractStats(b.parsed);
  console.log(
    `  A stats: t=${sa.topLevelTableBlocks}, tr=${sa.totalTrNodes}, tc=${sa.totalTcNodes}, pipe=${sa.topLevelPipeParagraphs}, missing=[${sa.missingTableAttrs.join(',') || 'none'}]`,
  );
  console.log(
    `  B stats: t=${sb.topLevelTableBlocks}, tr=${sb.totalTrNodes}, tc=${sb.totalTcNodes}, pipe=${sb.topLevelPipeParagraphs}, missing=[${sb.missingTableAttrs.join(',') || 'none'}]`,
  );
}

export async function cmdCompareCloudLocal(
  cfg: DiagnoseConfig,
  opts: CompareCloudLocalOptions,
): Promise<void> {
  const api = loginApi(cfg.cookiesPath);
  if (!api) return;
  const meta = new MetadataStore(cfg.metadataPath);
  const rec = meta.getFileInfo(opts.target as RelPath);
  meta.close();
  if (!rec?.fileId) {
    console.log(`MISS ${opts.target}: no file_id in metadata`);
    process.exitCode = 1;
    return;
  }
  const localPath = join(cfg.localDir, opts.target);
  if (!existsSync(localPath)) {
    console.log(`MISS ${opts.target}: local file does not exist`);
    process.exitCode = 1;
    return;
  }
  const raw = await api.getFileById(rec.fileId);
  const fileType = detectFileType(new Uint8Array(raw), '.md');
  const cloudMd = convertToMarkdown(new Uint8Array(raw), fileType);
  if (cloudMd === null) {
    console.log(`SKIP ${opts.target}: cloud content is binary (${fileType})`);
    return;
  }
  const localMd = readFileSync(localPath, 'utf-8');
  console.log('='.repeat(60));
  console.log(`  Compare cloud vs local: ${opts.target}`);
  console.log('='.repeat(60));
  console.log(`  fileType=${fileType}, cloudLen=${cloudMd.length}, localLen=${localMd.length}`);
  if (cloudMd === localMd) {
    console.log('  result: IDENTICAL');
    return;
  }
  console.log('  result: DIFFERENT');
  printLineDiff(localMd, cloudMd, opts.maxDiffs ?? 8);
}
