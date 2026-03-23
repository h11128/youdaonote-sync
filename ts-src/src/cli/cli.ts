import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { SyncEngine } from '../engine/engine.js';
import { SyncWatcher } from '../engine/watcher.js';
import { registerBrowseCommands } from './browse.js';
import { getConfigDir, warnIfLegacyConfig, migrateConfigFiles } from '../util/config-dir.js';

interface Config {
  local_dir: string;
  ydnote_dir: string;
  smms_secret_token?: string;
  is_relative_path?: boolean;
  sync_include?: string[];
  sync_exclude?: string[];
}

function loadConfig(configDir: string): Config {
  const configPath = join(configDir, 'config.json');
  if (!existsSync(configPath)) {
    return { local_dir: '', ydnote_dir: '' };
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
  const configDir = getConfigDir();
  const config = loadConfig(configDir);
  const localDir = opts.dir ?? config.local_dir;
  if (!localDir) {
    console.error('Error: local_dir not set in config.json (or use --dir)');
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
  });
  try {
    const t0 = Date.now();
    const result = await engine.sync();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const s = result.stats;
    const delPart =
      s.deletedCloud + s.deletedLocal > 0 ? ` 🗑${s.deletedCloud}c/${s.deletedLocal}l` : '';
    console.log(
      `\nSync complete: ↓${s.downloaded} ↑${s.uploaded} ⚡${s.conflicts} →${s.moved}${delPart} (${s.skipped} skipped, ${s.errors} errors) [${elapsed}s]`,
    );
    if (s.failedFiles.length > 0) {
      console.log('\nFailed files:');
      for (const f of s.failedFiles) {
        console.log(`  ✗ [${f.action}] ${f.path}: ${f.error}`);
      }
    }
  } finally {
    engine.close();
  }
}

function runWatchAction(opts: { interval: string; git?: boolean }): void {
  const configDir = getConfigDir();
  const config = loadConfig(configDir);
  if (!config.local_dir) {
    console.error('Error: local_dir not set in config.json');
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
  warnIfLegacyConfig();

  const program = new Command();
  program
    .name('youdaonote-sync')
    .description('Youdao Note sync tool (TypeScript)')
    .version('0.1.0');

  registerSyncCommands(program);
  registerUtilCommands(program);
  registerBrowseCommands(program, getConfigDir, loadConfig);
  registerDiagnoseCommands(program);

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
    .action((opts: SyncActionOpts) => {
      void runSyncAction(opts);
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
      void import('../api/auth.js').then(({ browserLogin }) =>
        browserLogin().then((code) => process.exit(code)),
      );
    });
}

function registerUtilCommands(program: Command): void {
  program
    .command('migrate')
    .description('Migrate config files from legacy cwd/config/ to platform config dir')
    .action(() => {
      const oldDir = join(process.cwd(), 'config');
      const newDir = getConfigDir();
      console.log(`Migrating: ${oldDir} → ${newDir}`);
      const copied = migrateConfigFiles(oldDir, newDir);
      if (copied.length === 0) {
        console.log('Nothing to migrate (source missing or destination already has files).');
      }
    });

  program
    .command('gui')
    .description('Open web-based GUI for browsing and downloading notes')
    .option('--port <number>', 'HTTP server port', '3456')
    .action((opts: { port: string }) => {
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

function registerDiagnoseCommands(program: Command): void {
  const diagnose = program.command('diagnose').description('Sync diagnostic tools');

  diagnose
    .command('path')
    .description('Search for paths in cloud scan results')
    .requiredOption('--target <paths...>', 'File paths to look up')
    .action((opts: { target: string[] }) => {
      void import('../tools/diagnose.js').then(({ cmdPath }) =>
        cmdPath(diagnoseCfg(), opts.target),
      );
    });

  diagnose
    .command('decision')
    .description('Re-run classify for specific files and show details')
    .requiredOption('--target <paths...>', 'File paths to analyze')
    .action((opts: { target: string[] }) => {
      void import('../tools/diagnose.js').then(({ cmdDecision }) =>
        cmdDecision(diagnoseCfg(), opts.target),
      );
    });

  diagnose
    .command('summary')
    .description('Dry-run summary: classify all files and show stats')
    .action(() => {
      void import('../tools/diagnose.js').then(({ cmdSummary }) => cmdSummary(diagnoseCfg()));
    });

  diagnose
    .command('reset-cache')
    .description('Reset scan cache version to force full cloud scan')
    .action(() => {
      void import('../tools/diagnose.js').then(({ cmdResetCache }) => {
        cmdResetCache(diagnoseCfg());
      });
    });

  registerDiagnoseToolCommands(diagnose);
  registerDiagnoseCacheCommands(diagnose);
}

function registerDiagnoseToolCommands(diagnose: Command): void {
  diagnose
    .command('api-status')
    .description('Check API connectivity and cookie validity')
    .action(() => {
      void import('../tools/diagnose.js').then(({ cmdApiStatus }) => cmdApiStatus(diagnoseCfg()));
    });

  diagnose
    .command('local')
    .description('Analyze local directory: file types, extensions, non-.md stats')
    .action(() => {
      void import('../tools/diagnose.js').then(({ cmdLocalStats }) => {
        cmdLocalStats(diagnoseCfg().localDir);
      });
    });

  diagnose
    .command('profile')
    .description('Dry-run with per-phase timing and CPU profiling')
    .option('--no-cpu', 'Skip CPU profiling (faster)')
    .option('--top <n>', 'Number of hot functions to show', '20')
    .action((opts: { cpu: boolean; top: string }) => {
      void import('../tools/profile-command.js').then(({ cmdProfile }) =>
        cmdProfile(diagnoseCfg(), { cpu: opts.cpu, top: parseInt(opts.top, 10) }),
      );
    });
}

function registerDiagnoseCacheCommands(diagnose: Command): void {
  diagnose
    .command('cache')
    .description('Report metadata cache stats: file counts, file_id, cloud_mtime, local existence')
    .action(() => {
      void import('../tools/diagnose.js').then(({ cmdCache }) => {
        cmdCache(diagnoseCfg());
      });
    });

  diagnose
    .command('rebuild')
    .description('Rebuild metadata from cloud + local scan')
    .option('--dry-run', 'Preview changes without writing')
    .action((opts: { dryRun?: boolean }) => {
      void import('../tools/diagnose.js').then(({ cmdRebuild }) => {
        void cmdRebuild(diagnoseCfg(), opts.dryRun ?? false);
      });
    });

  diagnose
    .command('duplicates')
    .description('Scan for duplicate files by content hash')
    .option('--dir <path>', 'Directory to scan (default: config local_dir)')
    .action((opts: { dir?: string }) => {
      void import('../tools/diagnose.js').then(({ cmdDuplicates }) => {
        const cfg = diagnoseCfg();
        cmdDuplicates(opts.dir ?? cfg.localDir);
      });
    });
}

function diagnoseCfg(): { cookiesPath: string; metadataPath: string; localDir: string } {
  const configDir = getConfigDir();
  const config = loadConfig(configDir);
  if (!config.local_dir) {
    console.error('Error: local_dir not set in config.json');
    process.exit(1);
  }
  return {
    cookiesPath: join(configDir, COOKIES_FILE),
    metadataPath: join(configDir, METADATA_FILE),
    localDir: config.local_dir,
  };
}
