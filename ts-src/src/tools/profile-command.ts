/**
 * `diagnose profile` command — dry-run with per-phase timing, CPU profiling,
 * and hot-function analysis. Integrated into the CLI for long-term reuse.
 */

import { dirname, extname, join } from 'node:path';
import { SyncEngine } from '../engine.js';
import { SyncProfiler, fmtMs } from '../perf/profiler.js';
import { analyzeCpuProfile, printCpuReport } from '../perf/analyzer.js';
import type { DiagnoseConfig } from './diagnose.js';
import type { RelPath } from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import type { FileState } from '../types/state.js';

export interface ProfileOptions {
  cpu: boolean;
  top: number;
}

export async function cmdProfile(cfg: DiagnoseConfig, opts: ProfileOptions): Promise<void> {
  const profiler = new SyncProfiler();
  const profileDir = join(dirname(cfg.metadataPath), '..', 'profiles');

  if (opts.cpu) {
    await profiler.startCpuProfile();
  }

  console.log('\n⏱  Starting profiled dry-run...\n');

  const engine = new SyncEngine({
    cookiesPath: cfg.cookiesPath,
    metadataPath: cfg.metadataPath,
    localDir: cfg.localDir,
    dryRun: true,
    profiler,
  });

  try {
    const { classified, cloudSnap, localSnap } = await engine.collectItems();

    let cpuProfilePath: string | null = null;
    if (opts.cpu) {
      cpuProfilePath = await profiler.stopCpuProfile(profileDir);
    }

    printReport({ profiler, classified, cloudSnap, localSnap, cpuProfilePath, topN: opts.top });
  } catch (e) {
    if (opts.cpu) await profiler.abortCpuProfile(profileDir);
    throw e;
  } finally {
    engine.close();
  }
}

interface ReportInput {
  profiler: SyncProfiler;
  classified: Map<RelPath, FileState>;
  cloudSnap: Map<RelPath, CloudFile>;
  localSnap: Map<RelPath, LocalFile>;
  cpuProfilePath: string | null;
  topN: number;
}

function printReport(input: ReportInput): void {
  const { profiler, classified, cloudSnap, localSnap, cpuProfilePath, topN } = input;
  const totalMs = profiler.getWallMs();

  console.log('═'.repeat(70));
  console.log('  SYNC PROFILE REPORT');
  console.log('═'.repeat(70));

  profiler.printTimingReport();

  printClassification(classified);
  printFileStats(localSnap, cloudSnap);

  if (cpuProfilePath) {
    const hotFns = analyzeCpuProfile(cpuProfilePath, topN);
    printCpuReport(hotFns);
    console.log();
    console.log(`  CPU profile saved: ${cpuProfilePath}`);
  }

  console.log();
  console.log(`  Wall clock: ${fmtMs(totalMs)}`);
  console.log('═'.repeat(70));
  console.log();
}

function printClassification(classified: Map<RelPath, FileState>): void {
  const counts = new Map<string, number>();
  for (const state of classified.values()) {
    counts.set(state.kind, (counts.get(state.kind) ?? 0) + 1);
  }

  console.log();
  console.log('  Classification');
  for (const [kind, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${kind.padEnd(28)} ${count}`);
  }
}

function printFileStats(
  localSnap: Map<RelPath, LocalFile>,
  cloudSnap: Map<RelPath, CloudFile>,
): void {
  const extCounts = new Map<string, number>();
  let totalSize = 0;
  let fileCount = 0;
  for (const local of localSnap.values()) {
    if (local.isDir) continue;
    fileCount++;
    const ext = extname(local.path).toLowerCase() || '(no ext)';
    extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    totalSize += local.size ?? 0;
  }

  let cloudFileCount = 0;
  for (const cf of cloudSnap.values()) {
    if (!cf.isDir) cloudFileCount++;
  }

  console.log();
  console.log(`  Local files: ${fileCount} (${(totalSize / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  Cloud files: ${cloudFileCount}`);
  console.log();
  console.log('  Top extensions (local)');
  for (const [ext, count] of [...extCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${ext.padEnd(10)} ${count}`);
  }
}
