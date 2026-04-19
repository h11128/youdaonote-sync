import { mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SERVICE_NAME = 'youdaonote-sync';
const PREFIX = '[youdaonote]';
const RETENTION_DAYS = 30;
const MAX_SIZE_MB = 100;

let verbose = process.env.YOUDAONOTE_VERBOSE === '1' || process.env.YOUDAONOTE_VERBOSE === 'true';

export function setVerbose(v: boolean): void {
  verbose = v;
}

// ── File logging setup ────────────────────────────────────────────

const logDir = join(homedir(), 'myforge-logs', SERVICE_NAME);
let logFilePath: string | null = null;

function ensureLogDir(): void {
  if (logFilePath) return;
  try {
    mkdirSync(logDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    logFilePath = join(logDir, `${SERVICE_NAME}.log.${today}`);
  } catch {
    // Fall back to console-only if dir creation fails
  }
}

function jsonLine(level: string, message: string): string {
  const now = new Date();
  const entry = {
    timestamp: now.toISOString(),
    level,
    target: SERVICE_NAME,
    message,
    service: SERVICE_NAME,
  };
  return JSON.stringify(entry);
}

function writeToFile(level: string, message: string): void {
  ensureLogDir();
  if (!logFilePath) return;
  try {
    appendFileSync(logFilePath, jsonLine(level, message) + '\n');
  } catch {
    // Swallow file-write errors to avoid breaking the main flow
  }
}

// ── Cleanup old logs (age OR size cap) ────────────────────────────

function cleanupOldLogs(): void {
  try {
    const files = readdirSync(logDir)
      .filter((f) => f.startsWith(`${SERVICE_NAME}.log.`))
      .map((f) => ({ name: f, path: join(logDir, f), stat: statSync(join(logDir, f)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    let totalSize = 0;
    const maxBytes = MAX_SIZE_MB * 1024 * 1024;

    for (const f of files) {
      totalSize += f.stat.size;
      if (f.stat.mtimeMs < cutoff || totalSize > maxBytes) {
        try {
          unlinkSync(f.path);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    // Cleanup is best-effort
  }
}

// Run cleanup on module load (once per process)
ensureLogDir();
cleanupOldLogs();

// ── Public logger ─────────────────────────────────────────────────

export const logger = {
  info(...args: unknown[]): void {
    const msg = args.map(String).join(' ');
    console.log(PREFIX, ...args);
    writeToFile('INFO', msg);
  },
  warn(...args: unknown[]): void {
    const msg = args.map(String).join(' ');
    console.warn(PREFIX, ...args);
    writeToFile('WARN', msg);
  },
  error(...args: unknown[]): void {
    const msg = args.map(String).join(' ');
    console.error(PREFIX, ...args);
    writeToFile('ERROR', msg);
  },
  debug(...args: unknown[]): void {
    const msg = args.map(String).join(' ');
    if (verbose) console.log(PREFIX, '[debug]', ...args);
    writeToFile('DEBUG', msg);
  },
};
