import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { markdownToNoteJson } from '../convert/md-to-note.js';
import { jsonBytesToMarkdown } from '../convert/json-to-md.js';
import { MetadataStore } from '../metadata/store.js';
import { NoteDomain } from '../types/common.js';

interface RoundtripResult {
  scanned: number;
  passed: number;
  failed: number;
  failures: { path: string; diff: string }[];
}

function normalizeForComparison(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join('\n');
}

function roundtrip(md: string): string {
  const json = markdownToNoteJson(md);
  const buf = new TextEncoder().encode(json);
  return jsonBytesToMarkdown(buf);
}

function findDiffLine(original: string, converted: string): string {
  const origLines = original.split('\n');
  const convLines = converted.split('\n');
  const maxLen = Math.max(origLines.length, convLines.length);

  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i] ?? '(missing)';
    const c = convLines[i] ?? '(missing)';
    if (o !== c) {
      return `line ${i + 1}: ${JSON.stringify(o)} → ${JSON.stringify(c)}`;
    }
  }
  return `length: ${origLines.length} → ${convLines.length}`;
}

function processMdFile(baseDir: string, relPath: string, result: RoundtripResult): void {
  const fullPath = join(baseDir, relPath);
  try {
    const content = readFileSync(fullPath, 'utf-8');
    const normalized = normalizeForComparison(content);
    const converted = normalizeForComparison(roundtrip(content));

    result.scanned++;
    if (normalized === converted) {
      result.passed++;
      return;
    }
    result.failed++;
    if (result.failures.length < 20) {
      result.failures.push({
        path: relPath,
        diff: findDiffLine(normalized, converted),
      });
    }
  } catch {
    // skip unreadable files
  }
}

function walkMdFiles(
  baseDir: string,
  rel: string,
  noteDomain: Set<string> | null,
  result: RoundtripResult,
): void {
  const dir = rel ? join(baseDir, rel) : baseDir;
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
      walkMdFiles(baseDir, relPath, noteDomain, result);
      continue;
    }

    if (extname(entry.name).toLowerCase() !== '.md') continue;
    if (noteDomain && !noteDomain.has(relPath)) continue;

    processMdFile(baseDir, relPath, result);
  }
}

function loadNoteDomainPaths(metadataPath: string): Set<string> {
  const meta = new MetadataStore(metadataPath);
  const noteDomain = new Set<string>();
  for (const [path, info] of meta.getAllFiles()) {
    if (info.domain === NoteDomain.NOTE) noteDomain.add(path);
  }
  meta.close();
  return noteDomain;
}

function applyPrefixFilter(paths: Set<string>, filter: string): Set<string> {
  const filtered = new Set<string>();
  for (const path of paths) {
    if (path.startsWith(filter)) filtered.add(path);
  }
  return filtered;
}

export function cmdRoundtripCheck(
  metadataPath: string,
  localDir: string,
  opts?: { noteOnly?: boolean; filter?: string | undefined },
): void {
  const noteOnly = opts?.noteOnly ?? true;
  const filter = opts?.filter;

  let noteDomain: Set<string> | null = noteOnly ? loadNoteDomainPaths(metadataPath) : null;
  if (filter && noteDomain) noteDomain = applyPrefixFilter(noteDomain, filter);

  console.log('='.repeat(60));
  console.log('  Roundtrip check: md → note JSON → md');
  console.log('='.repeat(60));

  if (noteDomain) {
    console.log(`  Scope: ${noteDomain.size} NOTE-domain files`);
  } else {
    console.log('  Scope: all .md files');
  }

  const result: RoundtripResult = { scanned: 0, passed: 0, failed: 0, failures: [] };
  walkMdFiles(localDir, '', noteDomain, result);

  console.log(`\n  Scanned: ${result.scanned}`);
  console.log(`  Passed:  ${result.passed}`);
  console.log(`  Failed:  ${result.failed}`);

  if (result.failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of result.failures) {
      console.log(`    ${f.path}`);
      console.log(`      ${f.diff}`);
    }
  }

  if (result.failed === 0) {
    console.log('\n  ✅ All files pass roundtrip check');
  }
}
