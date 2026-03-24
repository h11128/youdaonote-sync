/**
 * diagnose check-content: verify .md files contain Markdown, not raw structured data.
 */

import { extname, join } from 'node:path';
import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';

interface ContentAnomaly {
  relPath: string;
  detected: string;
  size: number;
}

function detectContentAnomaly(fullPath: string): string | null {
  const buf = Buffer.alloc(50);
  let fd: number;
  try {
    fd = openSync(fullPath, 'r');
  } catch {
    return null;
  }
  try {
    readSync(fd, buf, 0, 50, 0);
  } finally {
    closeSync(fd);
  }
  const prefix = buf.toString('utf-8').trimStart();
  if (prefix.startsWith('{"')) return 'JSON';
  if (prefix.startsWith('<?xml')) return 'XML';
  if (/^<!DOCTYPE\s+html/i.test(prefix) || /^<html/i.test(prefix)) return 'HTML';
  return null;
}

function checkSingleFile(localDir: string, rel: string, results: ContentAnomaly[]): void {
  const fullPath = join(localDir, rel);
  const detected = detectContentAnomaly(fullPath);
  if (!detected) return;
  let size = 0;
  try {
    size = statSync(fullPath).size;
  } catch {
    /* ignore */
  }
  results.push({ relPath: rel, detected, size });
}

function walkMdFiles(localDir: string, base: string, results: ContentAnomaly[]): void {
  const dir = base ? join(localDir, base) : localDir;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      walkMdFiles(localDir, rel, results);
    } else if (extname(e.name).toLowerCase() === '.md') {
      checkSingleFile(localDir, rel, results);
    }
  }
}

/**
 * Scan all .md files in localDir and report those whose content is
 * raw JSON/XML/HTML instead of Markdown.
 */
export function cmdCheckContent(localDir: string): void {
  const anomalies: ContentAnomaly[] = [];
  walkMdFiles(localDir, '', anomalies);

  console.log('='.repeat(60));
  console.log('  Content format check (.md files)');
  console.log('='.repeat(60));

  if (anomalies.length === 0) {
    console.log('  All .md files contain valid Markdown content.');
    return;
  }

  console.log(`  Found ${anomalies.length} file(s) with unexpected content:\n`);
  for (const a of anomalies) {
    console.log(`  ${a.detected.padEnd(5)} ${a.relPath} (${a.size} bytes)`);
  }
  console.log('\n  These files may need re-downloading with the fixed conversion pipeline.');
}
