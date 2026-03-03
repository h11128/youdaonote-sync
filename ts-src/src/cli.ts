import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { SyncEngine } from './engine.js';
import { SyncWatcher } from './watcher.js';
import { gitAutoCommit, gitInit } from './git.js';
import { stateToAction } from './types/state.js';

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
    .action(async (opts: { dryRun?: boolean; git?: boolean }) => {
      const configDir = getConfigDir();
      const config = loadConfig(configDir);

      if (!config.local_dir) {
        console.error('Error: local_dir not set in config.json');
        process.exit(1);
      }

      const engine = new SyncEngine({
        cookiesPath: join(configDir, 'cookies.json'),
        metadataPath: join(configDir, 'sync_metadata.db'),
        localDir: config.local_dir,
        syncInclude: config.sync_include,
        syncExclude: config.sync_exclude,
        dryRun: opts.dryRun,
      });

      try {
        const result = await engine.sync();
        const s = result.stats;

        if (opts.dryRun) {
          console.log('\n=== Dry-Run Results ===');
          for (const [path, state] of result.classified) {
            const action = stateToAction(state);
            if (action !== 'skip') {
              console.log(`  ${action.padEnd(10)} ${path}`);
            }
          }
        }

        console.log(`\nSync complete: ↓${s.downloaded} ↑${s.uploaded} ⚡${s.conflicts} →${s.moved} (${s.skipped} skipped, ${s.errors} errors)`);

        if (opts.git && !opts.dryRun) {
          gitAutoCommit(config.local_dir, {
            changedPaths: [...s.changedPaths],
            stats: { downloaded: s.downloaded, uploaded: s.uploaded, conflicts: s.conflicts },
          });
        }
      } finally {
        engine.close();
      }
    });

  program
    .command('watch')
    .description('Watch for changes and sync periodically')
    .option('--interval <seconds>', 'Sync interval in seconds', '300')
    .option('--git', 'Auto-commit changes to git after each sync')
    .action((opts: { interval: string; git?: boolean }) => {
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
