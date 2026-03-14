/**
 * SyncProfiler — reusable phase-timing and CPU profiling for the sync engine.
 *
 * Usage:
 *   const profiler = new SyncProfiler();
 *   await profiler.startCpuProfile();   // optional
 *   profiler.beginPhase('myPhase');
 *   // ... work ...
 *   profiler.endPhase('42 items');
 *   const cpuPath = await profiler.stopCpuProfile('profiles');
 *   profiler.printTimingReport();
 */

import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';

interface InspectorSession {
  post(method: string): Promise<{ profile?: unknown }>;
  connect(): void;
  disconnect(): void;
}

export interface PhaseRecord {
  name: string;
  ms: number;
  detail?: string | undefined;
}

export class SyncProfiler {
  private readonly phases: PhaseRecord[] = [];
  private currentPhase: string | null = null;
  private phaseStart = 0;
  private readonly wallStart = performance.now();

  private session: InspectorSession | null = null;
  private cpuProfilingActive = false;

  beginPhase(name: string): void {
    if (this.currentPhase !== null) {
      this.endPhase();
    }
    this.currentPhase = name;
    this.phaseStart = performance.now();
  }

  endPhase(detail?: string): void {
    if (this.currentPhase === null) return;
    this.phases.push({
      name: this.currentPhase,
      ms: performance.now() - this.phaseStart,
      detail,
    });
    this.currentPhase = null;
  }

  getPhases(): readonly PhaseRecord[] {
    return this.phases;
  }

  getWallMs(): number {
    return performance.now() - this.wallStart;
  }

  async startCpuProfile(): Promise<void> {
    const { Session } = await import('node:inspector/promises');
    const s: InspectorSession = new Session();
    s.connect();
    await s.post('Profiler.enable');
    await s.post('Profiler.start');
    this.session = s;
    this.cpuProfilingActive = true;
  }

  /**
   * Stop CPU profiling and write the .cpuprofile file.
   * Returns the absolute path to the saved file, or null if profiling was not active.
   */
  async stopCpuProfile(outDir: string): Promise<string | null> {
    if (!this.session || !this.cpuProfilingActive) return null;
    const { profile } = await this.session.post('Profiler.stop');
    this.session.disconnect();
    this.cpuProfilingActive = false;
    this.session = null;

    mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const outPath = `${outDir}/cpu-${ts}.cpuprofile`;
    writeFileSync(outPath, JSON.stringify(profile));
    return outPath;
  }

  /**
   * Best-effort cleanup if an error occurs mid-profiling.
   * Saves the partial profile to `<outDir>/cpu-error-<timestamp>.cpuprofile`.
   */
  async abortCpuProfile(outDir: string): Promise<void> {
    if (!this.session || !this.cpuProfilingActive) return;
    try {
      const { profile } = await this.session.post('Profiler.stop');
      this.session.disconnect();
      mkdirSync(outDir, { recursive: true });
      writeFileSync(`${outDir}/cpu-error-${Date.now()}.cpuprofile`, JSON.stringify(profile));
    } catch {
      /* best effort */
    }
    this.cpuProfilingActive = false;
    this.session = null;
  }

  printTimingReport(): void {
    const totalMs = this.getWallMs();
    const nameWidth = Math.max(...this.phases.map((p) => p.name.length), 18) + 2;

    console.log();
    console.log('  Phase Timing');
    console.log(`  ${'─'.repeat(nameWidth)} ${'─'.repeat(10)} ${'─'.repeat(6)}  ${'─'.repeat(30)}`);
    for (const p of this.phases) {
      console.log(
        `  ${p.name.padEnd(nameWidth)} ${fmtMs(p.ms).padStart(10)} ${pct(p.ms, totalMs).padStart(6)}  ${p.detail ?? ''}`,
      );
    }
    const accounted = this.phases.reduce((s, p) => s + p.ms, 0);
    console.log(`  ${'─'.repeat(nameWidth)} ${'─'.repeat(10)} ${'─'.repeat(6)}`);
    console.log(
      `  ${'TOTAL (accounted)'.padEnd(nameWidth)} ${fmtMs(accounted).padStart(10)} ${pct(accounted, totalMs).padStart(6)}`,
    );
    console.log(
      `  ${'TOTAL (wall clock)'.padEnd(nameWidth)} ${fmtMs(totalMs).padStart(10)} ${'100%'.padStart(6)}`,
    );
  }
}

export function fmtMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function pct(ms: number, total: number): string {
  return total > 0 ? `${((ms / total) * 100).toFixed(1)}%` : '-';
}
