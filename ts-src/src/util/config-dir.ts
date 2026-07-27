import { join } from 'node:path';
import { existsSync, copyFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { logger } from './logger.js';

const APP_NAME = 'youdaonote-sync';
const CONFIG_JSON = 'config.json';
const COOKIES_JSON = 'cookies.json';
const METADATA_DB = 'sync_metadata.db';
const MIGRATE_FILES = [CONFIG_JSON, COOKIES_JSON, METADATA_DB] as const;

export type ConfigSource = 'env' | 'platform';

export interface ConfigSotReport {
  /** Single source of truth — the only directory the CLI reads/writes. */
  configDir: string;
  source: ConfigSource;
  legacyDir: string;
  hasSotConfig: boolean;
  hasLegacyConfig: boolean;
  /** Both SOT and legacy have config.json — edits to legacy are ignored. */
  conflict: boolean;
  files: { configJson: boolean; cookiesJson: boolean; metadataDb: boolean };
  message: string;
}

/**
 * Resolve the youdaonote-sync config directory (SOT).
 *
 * Priority:
 * 1. YOUDAONOTE_CONFIG_DIR env var (explicit override)
 * 2. Platform default:
 *    - Windows: %APPDATA%/youdaonote-sync
 *    - Linux/Mac: ~/.config/youdaonote-sync
 *
 * Repo-local `config/` is legacy only — never the runtime SOT when a platform
 * dir exists. Templates live in the repo as examples/config.example.json and
 * examples/.env.example.
 */
export function getConfigDir(): string {
  const fromEnv = process.env.YOUDAONOTE_CONFIG_DIR?.trim();
  if (fromEnv) return fromEnv;
  const appData = process.env.APPDATA ?? join(homedir(), '.config');
  return join(appData, APP_NAME);
}

export function getConfigSource(): ConfigSource {
  return process.env.YOUDAONOTE_CONFIG_DIR?.trim() ? 'env' : 'platform';
}

export function getLegacyConfigDir(cwd: string = process.cwd()): string {
  return join(cwd, 'config');
}

export function inspectConfigSot(cwd: string = process.cwd()): ConfigSotReport {
  const configDir = getConfigDir();
  const source = getConfigSource();
  const legacyDir = getLegacyConfigDir(cwd);
  const hasSotConfig = existsSync(join(configDir, CONFIG_JSON));
  const hasLegacyConfig = legacyDir !== configDir && existsSync(join(legacyDir, CONFIG_JSON));
  const conflict = hasSotConfig && hasLegacyConfig;
  const files = {
    configJson: hasSotConfig,
    cookiesJson: existsSync(join(configDir, COOKIES_JSON)),
    metadataDb: existsSync(join(configDir, METADATA_DB)),
  };
  return {
    configDir,
    source,
    legacyDir,
    hasSotConfig,
    hasLegacyConfig,
    conflict,
    files,
    message: formatSotMessage({
      configDir,
      source,
      legacyDir,
      hasSotConfig,
      hasLegacyConfig,
      conflict,
      files,
    }),
  };
}

function platformSotLabel(): string {
  if (process.platform === 'win32') return '%APPDATA%\\youdaonote-sync';
  return '~/.config/youdaonote-sync';
}

function formatSotMessage(r: Omit<ConfigSotReport, 'message'>): string {
  const src = r.source === 'env' ? 'YOUDAONOTE_CONFIG_DIR' : platformSotLabel();
  if (r.conflict) {
    return [
      `Config CONFLICT: two ${CONFIG_JSON} locations exist.`,
      `  SOT (active): ${r.configDir}  ← CLI reads this only`,
      `  Legacy (ignored): ${r.legacyDir}`,
      `Fix: delete or rename the legacy folder, or set YOUDAONOTE_CONFIG_DIR.`,
      `Check: npx youdaonote-sync config doctor`,
    ].join('\n');
  }
  if (!r.hasSotConfig && r.hasLegacyConfig) {
    return `Legacy config found at ${r.legacyDir}; will migrate into SOT ${r.configDir} (${src}).`;
  }
  if (!r.hasSotConfig) {
    return [
      `No ${CONFIG_JSON} in SOT: ${r.configDir}`,
      `Copy examples/config.example.json → ${join(r.configDir, CONFIG_JSON)} and set local_dir.`,
      `Then: npx youdaonote-sync login`,
    ].join('\n');
  }
  return `Config SOT OK: ${r.configDir} (source=${src})`;
}

/**
 * Ensure a single runtime config directory:
 * - If only legacy exists → migrate into SOT, then rename legacy away
 * - If both already exist → conflict (caller should refuse sync)
 * - Never read runtime settings from the repo `config/` once SOT has config.json
 */
export function ensureConfigSot(cwd: string = process.cwd()): ConfigSotReport {
  let report = inspectConfigSot(cwd);
  if (!report.hasSotConfig && report.hasLegacyConfig) {
    const copied = migrateConfigFiles(report.legacyDir, report.configDir);
    if (copied.length > 0) {
      logger.info(`[config] Migrated ${copied.join(', ')} → ${report.configDir}`);
    }
    retireLegacyConfigDir(report.legacyDir);
    report = inspectConfigSot(cwd);
  }
  if (report.conflict) {
    logger.error(report.message);
  } else if (!report.hasSotConfig) {
    logger.warn(report.message);
  }
  return report;
}

/** Move leftover repo config/ aside so it cannot fight the SOT. */
export function retireLegacyConfigDir(legacyDir: string): string | null {
  if (!existsSync(legacyDir)) return null;
  const stamp = new Date().toISOString().slice(0, 10);
  let dest = `${legacyDir}.migrated-${stamp}`;
  let n = 1;
  while (existsSync(dest)) {
    dest = `${legacyDir}.migrated-${stamp}-${n++}`;
  }
  try {
    renameSync(legacyDir, dest);
    logger.info(`[config] Renamed legacy ${legacyDir} → ${dest} (SOT is now the only config)`);
    return dest;
  } catch (e: unknown) {
    logger.warn(
      `[config] Could not rename legacy ${legacyDir}: ${e instanceof Error ? e.message : String(e)}. ` +
        `Delete it manually to clear the conflict.`,
    );
    return null;
  }
}

/** Exit the process when dual config.json would confuse users. */
export function assertConfigSot(cwd: string = process.cwd()): ConfigSotReport {
  const report = ensureConfigSot(cwd);
  if (report.conflict) {
    console.error(report.message);
    process.exit(1);
  }
  return report;
}

/**
 * Explicitly migrate config files from old to new location.
 * Returns the list of files successfully copied.
 */
export function migrateConfigFiles(oldDir: string, newDir: string): string[] {
  if (!oldDir || !newDir) throw new Error('migrateConfigFiles: oldDir and newDir are required');
  mkdirSync(newDir, { recursive: true });
  const copied: string[] = [];
  for (const file of MIGRATE_FILES) {
    const src = join(oldDir, file);
    const dest = join(newDir, file);
    if (!existsSync(src)) continue;
    if (existsSync(dest)) {
      logger.warn(`[migrate] Skipped ${file} (already exists at destination)`);
      continue;
    }
    try {
      copyFileSync(src, dest);
      copied.push(file);
    } catch (e: unknown) {
      logger.error(
        `[migrate] Failed to copy ${file}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (copied.length > 0) {
    logger.info(`[migrate] Copied ${copied.join(', ')} from ${oldDir} → ${newDir}`);
  }
  return copied;
}
