import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { SyncEngine } from '../engine/engine.js';
import { SyncWatcher } from '../engine/watcher.js';
import { registerBrowseCommands } from './browse.js';
import { registerDiagnoseCommands } from './diagnose-cli.js';
import { registerConfigCommands, requireConfigSot } from './config-cli.js';
import { getConfigDir } from '../util/config-dir.js';

interface Config {
  local_dir: string;
  smms_secret_token?: string;
  is_relative_path?: boolean;
  sync_include?: string[];
  sync_exclude?: string[];
  maxDeletesPerSync?: number;
}

function loadConfig(configDir: string): Config {
  const configPath = join(configDir, 'config.json');
  if (!existsSync(configPath)) {
    return { local_dir: '' };
  }
  return JSON.parse(readFileSync(configPath, 'utf-8')) as Config;
}

const COOKIES_FILE = 'cookies.json';
const METADATA_FILE = 'sync_metadata.db';

interface SyncActionOpts {
  dryRun?: boolean;
  git?: boolean;
  dir?: string;
  push?: boolean;
  pull?: boolean;
  noDedup?: boolean;
  propagateDeletes?: boolean;
}

function resolveDirection(opts: SyncActionOpts): 'both' | 'push' | 'pull' {
  if (opts.push && !opts.pull) return 'push';
  if (opts.pull && !opts.push) return 'pull';
  return 'both';
}

async function runSyncAction(opts: SyncActionOpts): Promise<void> {
  requireConfigSot();
  const configDir = getConfigDir();
  const config = loadConfig(configDir);
  const localDir = opts.dir ?? config.local_dir;
  if (!localDir) {
    console.error('Error: local_dir not set in config.json (or use --dir)');
    console.error(`Config SOT: ${configDir}`);
    console.error('Run: npx youdaonote-sync config doctor');
    process.exit(1);
  }
  const engine = new SyncEngine({
    cookiesPath: join(configDir, COOKIES_FILE),
    metadataPath: join(configDir, METADATA_FILE),
    localDir,
    syncInclude: config.sync_include,
    syncExclude: config.sync_exclude,
    dryRun: opts.dryRun,
    direction: resolveDirection(opts),
    autoDedup: opts.noDedup ? false : undefined,
    autoGit: opts.git ?? undefined,
    propagateDeletes: opts.propagateDeletes ?? undefined,
    maxDeletesPerSync: config.maxDeletesPerSync,
  });
  try {
    const t0 = Date.now();
    const result = await engine.sync();
    reportSyncResult(result, ((Date.now() - t0) / 1000).toFixed(1));
  } finally {
    engine.close();
  }
}

function reportSyncResult(result: Awaited<ReturnType<SyncEngine['sync']>>, elapsed: string): void {
  if (result.status === 'aborted') {
    console.error(`\nSync ABORTED (${result.reason ?? 'unknown'}) [${elapsed}s]`);
    process.exitCode = 3;
    return;
  }
  if (result.status === 'suspended') {
    console.error(`\nSync SUSPENDED (${result.reason ?? 'unknown'}) [${elapsed}s]`);
    if (result.reportPath) console.error(`Review report: ${result.reportPath}`);
    console.error(
      `Increase maxDeletesPerSync in config.json if the deletes are intentional, then re-run.`,
    );
    process.exitCode = 2;
    return;
  }

  const s = result.stats;
  const delPart =
    s.deletedCloud + s.deletedLocal > 0 ? ` 🗑${s.deletedCloud}c/${s.deletedLocal}l` : '';
  console.log(
    `\nSync complete: ↓${s.downloaded} ↑${s.uploaded} ⚡${s.conflicts} →${s.moved}${delPart} (${s.skipped} skipped, ${s.errors} errors) [${elapsed}s]`,
  );
  if (result.reportPath) console.log(`Report: ${result.reportPath}`);
  if (s.failedFiles.length > 0) {
    console.log('\nFailed files:');
    for (const f of s.failedFiles) {
      console.log(`  ✗ [${f.action}] ${f.path}: ${f.error}`);
    }
  }
  // Fail closed: file-level errors must surface to scheduled Task LastResult / PE log probe.
  if (s.errors > 0 || s.failedFiles.length > 0) {
    process.exitCode = 1;
  }
}

function runWatchAction(opts: { interval: string; git?: boolean }): void {
  requireConfigSot();
  const configDir = getConfigDir();
  const config = loadConfig(configDir);
  if (!config.local_dir) {
    console.error('Error: local_dir not set in config.json');
    console.error(`Config SOT: ${configDir}`);
    process.exit(1);
  }
  const watcher = new SyncWatcher(
    {
      cookiesPath: join(configDir, COOKIES_FILE),
      metadataPath: join(configDir, METADATA_FILE),
      localDir: config.local_dir,
      syncInclude: config.sync_include,
      syncExclude: config.sync_exclude,
    },
    parseInt(opts.interval, 10) * 1000,
  );
  process.on('SIGINT', () => {
    watcher.stop();
    process.exit(0);
  });
  void watcher.start();
}

export function createCli(): Command {
  const program = new Command();
  program
    .name('youdaonote-sync')
    .description('Youdao Note sync tool (TypeScript)')
    .version('0.1.0');

  registerSyncCommands(program);
  registerConfigCommands(program);
  registerUtilCommands(program);
  registerBrowseCommands(program, getConfigDir, loadConfig);
  registerDiagnoseCommands(program, getConfigDir, loadConfig);

  return program;
}

function registerSyncCommands(program: Command): void {
  program
    .command('sync')
    .description('Run sync once')
    .option('--dry-run', 'Preview changes without executing')
    .option('--git', 'Auto-commit changes to git after sync')
    .option('--dir <path>', 'Override local sync directory')
    .option('--push', 'Only push local changes to cloud')
    .option('--pull', 'Only pull cloud changes to local')
    .option('--no-dedup', 'Disable automatic deduplication')
    .option('--propagate-deletes', 'Propagate delete operations (with local trash)')
    .action(async (opts: SyncActionOpts) => {
      await runSyncAction(opts);
    });

  program
    .command('watch')
    .description('Watch for changes and sync periodically')
    .option('--interval <seconds>', 'Sync interval in seconds', '300')
    .option('--git', 'Auto-commit changes to git after each sync')
    .action((opts: { interval: string; git?: boolean }) => {
      runWatchAction(opts);
    });

  program
    .command('login')
    .description('Login via browser (Playwright)')
    .action(() => {
      requireConfigSot();
      void import('../api/auth.js').then(({ browserLogin }) =>
        browserLogin().then((code) => process.exit(code)),
      );
    });
}

function registerUtilCommands(program: Command): void {
  program
    .command('gui')
    .description('Open web-based GUI for browsing and downloading notes')
    .option('--port <number>', 'HTTP server port', '3456')
    .action((opts: { port: string }) => {
      requireConfigSot();
      const cfgDir = getConfigDir();
      const cfg = loadConfig(cfgDir);
      void import('../gui/server.js').then(({ startGuiServer }) => {
        startGuiServer({
          cookiesPath: join(cfgDir, COOKIES_FILE),
          defaultDownloadDir: cfg.local_dir || join(process.cwd(), 'youdaonote-sync'),
          port: parseInt(opts.port, 10),
        });
      });
    });
}
