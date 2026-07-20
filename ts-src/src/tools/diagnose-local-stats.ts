import { extname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import type { RelPath } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';

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

export function printExtStats(cloudSnap: Map<RelPath, CloudFile>): void {
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
