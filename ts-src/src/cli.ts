import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { SyncEngine } from './engine.js';
import { SyncWatcher } from './watcher.js';
import { registerBrowseCommands } from './cli-browse.js';

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

function getConfigDir(): string {
  return join(process.cwd(), 'config');
}

interface SyncActionOpts {
  dryRun?: boolean;
  git?: boolean;
  dir?: string;
  push?: boolean;
  pull?: boolean;
  noDedup?: boolean;
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
  });
  try {
    const result = await engine.sync();
    const s = result.stats;
    console.log(
      `\nSync complete: ↓${s.downloaded} ↑${s.uploaded} ⚡${s.conflicts} →${s.moved} (${s.skipped} skipped, ${s.errors} errors)`,
    );
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
  const program = new Command();
  program
    .name('youdaonote-sync')
    .description('Youdao Note sync tool (TypeScript)')
    .version('0.1.0');

  registerSyncCommands(program);
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
      void import('./api/auth.js').then(({ browserLogin }) =>
        browserLogin().then((code) => process.exit(code)),
      );
    });

  program
    .command('gui')
    .description('Open web-based GUI for browsing and downloading notes')
    .option('--port <number>', 'HTTP server port', '3456')
    .action((opts: { port: string }) => {
      const cfgDir = getConfigDir();
      const cfg = loadConfig(cfgDir);
      void import('./gui/server.js').then(({ startGuiServer }) => {
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
      void import('./tools/diagnose.js').then(({ cmdPath }) => cmdPath(diagnoseCfg(), opts.target));
    });

  diagnose
    .command('decision')
    .description('Re-run classify for specific files and show details')
    .requiredOption('--target <paths...>', 'File paths to analyze')
    .action((opts: { target: string[] }) => {
      void import('./tools/diagnose.js').then(({ cmdDecision }) =>
        cmdDecision(diagnoseCfg(), opts.target),
      );
    });

  diagnose
    .command('summary')
    .description('Dry-run summary: classify all files and show stats')
    .action(() => {
      void import('./tools/diagnose.js').then(({ cmdSummary }) => cmdSummary(diagnoseCfg()));
    });

  diagnose
    .command('reset-cache')
    .description('Reset scan cache version to force full cloud scan')
    .action(() => {
      void import('./tools/diagnose.js').then(({ cmdResetCache }) => {
        cmdResetCache(diagnoseCfg());
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
