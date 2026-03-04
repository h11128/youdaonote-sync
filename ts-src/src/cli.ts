import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { SyncEngine } from './engine.js';
import { SyncWatcher } from './watcher.js';

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
    cookiesPath: join(configDir, 'cookies.json'),
    metadataPath: join(configDir, 'sync_metadata.db'),
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
      cookiesPath: join(configDir, 'cookies.json'),
      metadataPath: join(configDir, 'sync_metadata.db'),
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
    .description('Login via browser (delegates to Python CLI for now)')
    .action(() => {
      console.log(
        'Browser login is not yet implemented in TypeScript.\n' +
          'Use: python -m src login\n' +
          'The cookies.json will be shared between Python and TS.',
      );
    });

  return program;
}
