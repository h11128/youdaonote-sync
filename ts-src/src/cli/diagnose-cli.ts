import type { Command } from 'commander';
import { join } from 'node:path';
import { addInspectDiagnoseCommands } from './diagnose-inspect-cli.js';

interface DiagnoseConfig {
  cookiesPath: string;
  metadataPath: string;
  localDir: string;
  syncExclude?: string[];
  syncInclude?: string[];
}

interface RootConfig {
  local_dir: string;
  sync_exclude?: string[];
  sync_include?: string[];
}

type GetConfigDir = () => string;
type LoadConfig = (configDir: string) => RootConfig;

const COOKIES_FILE = 'cookies.json';
const METADATA_FILE = 'sync_metadata.db';
const PREFIX_OPTION = 'Only process paths starting with this prefix';
const TARGET_PATHS_OPTION = 'File paths to process';
const TARGET_OPTION = '--target <paths...>';

function diagnoseCfg(getConfigDir: GetConfigDir, loadConfig: LoadConfig): DiagnoseConfig {
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
    ...(config.sync_exclude !== undefined ? { syncExclude: config.sync_exclude } : {}),
    ...(config.sync_include !== undefined ? { syncInclude: config.sync_include } : {}),
  };
}

function addBasicDiagnoseCommands(
  diagnose: Command,
  getConfigDir: GetConfigDir,
  loadConfig: LoadConfig,
): void {
  diagnose
    .command('path')
    .description('Search for paths in cloud scan results')
    .requiredOption(TARGET_OPTION, TARGET_PATHS_OPTION)
    .action((opts: { target: string[] }) => {
      void import('../tools/diagnose.js').then(({ cmdPath }) =>
        cmdPath(diagnoseCfg(getConfigDir, loadConfig), opts.target),
      );
    });

  diagnose
    .command('decision')
    .description('Re-run classify for specific files and show details')
    .requiredOption(TARGET_OPTION, TARGET_PATHS_OPTION)
    .action((opts: { target: string[] }) => {
      void import('../tools/diagnose.js').then(({ cmdDecision }) =>
        cmdDecision(diagnoseCfg(getConfigDir, loadConfig), opts.target),
      );
    });

  diagnose
    .command('summary')
    .description('Dry-run summary: classify all files and show stats')
    .action(() => {
      void import('../tools/diagnose.js').then(({ cmdSummary }) =>
        cmdSummary(diagnoseCfg(getConfigDir, loadConfig)),
      );
    });

  diagnose
    .command('reset-cache')
    .description('Reset scan cache version to force full cloud scan')
    .action(() => {
      void import('../tools/diagnose.js').then(({ cmdResetCache }) => {
        cmdResetCache(diagnoseCfg(getConfigDir, loadConfig));
      });
    });
}

function addOpsDiagnoseCommands(
  diagnose: Command,
  getConfigDir: GetConfigDir,
  loadConfig: LoadConfig,
): void {
  diagnose
    .command('api-status')
    .description('Check API connectivity and cookie validity')
    .action(() => {
      void import('../tools/diagnose.js').then(({ cmdApiStatus }) =>
        cmdApiStatus(diagnoseCfg(getConfigDir, loadConfig)),
      );
    });

  diagnose
    .command('local')
    .description('Analyze local directory: file types, extensions, non-.md stats')
    .action(() => {
      void import('../tools/diagnose.js').then(({ cmdLocalStats }) => {
        cmdLocalStats(diagnoseCfg(getConfigDir, loadConfig).localDir);
      });
    });

  diagnose
    .command('profile')
    .description('Dry-run with per-phase timing and CPU profiling')
    .option('--no-cpu', 'Skip CPU profiling (faster)')
    .option('--top <n>', 'Number of hot functions to show', '20')
    .action((opts: { cpu: boolean; top: string }) => {
      void import('../tools/profile-command.js').then(({ cmdProfile }) =>
        cmdProfile(diagnoseCfg(getConfigDir, loadConfig), {
          cpu: opts.cpu,
          top: Number.parseInt(opts.top, 10),
        }),
      );
    });
}

function addMaintenanceDiagnoseCommands(
  diagnose: Command,
  getConfigDir: GetConfigDir,
  loadConfig: LoadConfig,
): void {
  diagnose
    .command('cache')
    .description('Report metadata cache stats: file counts, file_id, cloud_mtime, local existence')
    .action(() => {
      void import('../tools/diagnose.js').then(({ cmdCache }) => {
        cmdCache(diagnoseCfg(getConfigDir, loadConfig));
      });
    });

  diagnose
    .command('rebuild')
    .description('Rebuild metadata from cloud + local scan')
    .option('--dry-run', 'Preview changes without writing')
    .action((opts: { dryRun?: boolean }) => {
      void import('../tools/diagnose.js').then(({ cmdRebuild }) => {
        void cmdRebuild(diagnoseCfg(getConfigDir, loadConfig), opts.dryRun ?? false);
      });
    });

  diagnose
    .command('duplicates')
    .description('Scan for duplicate files by content hash')
    .option('--dir <path>', 'Directory to scan (default: config local_dir)')
    .action((opts: { dir?: string }) => {
      void import('../tools/diagnose.js').then(({ cmdDuplicates }) => {
        const cfg = diagnoseCfg(getConfigDir, loadConfig);
        cmdDuplicates(opts.dir ?? cfg.localDir);
      });
    });

  diagnose
    .command('check-content')
    .description('Verify .md files contain Markdown, not raw JSON/XML/HTML')
    .option('--dir <path>', 'Directory to scan (default: config local_dir)')
    .action((opts: { dir?: string }) => {
      void import('../tools/diagnose.js').then(({ cmdCheckContent }) => {
        const cfg = diagnoseCfg(getConfigDir, loadConfig);
        cmdCheckContent(opts.dir ?? cfg.localDir);
      });
    });
}

function addHashDiagnoseCommands(
  diagnose: Command,
  getConfigDir: GetConfigDir,
  loadConfig: LoadConfig,
): void {
  diagnose
    .command('fix-hashes')
    .description('Recompute content hashes from local files and fix stale metadata')
    .option('--dry-run', 'Preview changes without writing')
    .option('--filter <prefix>', PREFIX_OPTION)
    .action((opts: { dryRun?: boolean; filter?: string }) => {
      void import('../tools/diagnose.js').then(({ cmdFixHashes }) => {
        const cfg = diagnoseCfg(getConfigDir, loadConfig);
        void cmdFixHashes(cfg.metadataPath, cfg.localDir, opts);
      });
    });

  diagnose
    .command('roundtrip-check')
    .description('Verify md→JSON→md roundtrip fidelity for NOTE-domain files')
    .option('--all', 'Check all .md files, not just NOTE-domain')
    .option('--filter <prefix>', PREFIX_OPTION)
    .action((opts: { all?: boolean; filter?: string }) => {
      void import('../tools/diagnose.js').then(({ cmdRoundtripCheck }) => {
        const cfg = diagnoseCfg(getConfigDir, loadConfig);
        cmdRoundtripCheck(cfg.metadataPath, cfg.localDir, {
          noteOnly: !opts.all,
          filter: opts.filter,
        });
      });
    });
}

function addForceAndCheckCommands(
  diagnose: Command,
  getConfigDir: GetConfigDir,
  loadConfig: LoadConfig,
): void {
  diagnose
    .command('force-reupload')
    .description('Set metadata content_hash marker to force upload on next sync')
    .requiredOption(TARGET_OPTION, TARGET_PATHS_OPTION)
    .option('--marker <value>', 'Custom marker string written into content_hash')
    .option('--dry-run', 'Preview changes without writing')
    .action((opts: { target: string[]; marker?: string; dryRun?: boolean }) => {
      void import('../tools/diagnose.js').then(({ cmdForceReupload }) => {
        const cfg = diagnoseCfg(getConfigDir, loadConfig);
        const forceOpts = {
          targets: opts.target,
          ...(opts.marker !== undefined ? { marker: opts.marker } : {}),
          ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
        };
        cmdForceReupload(cfg.metadataPath, forceOpts);
      });
    });

  diagnose
    .command('check-note-tables')
    .description('Inspect cloud NOTE JSON shape: native table vs pipe text')
    .requiredOption(TARGET_OPTION, TARGET_PATHS_OPTION)
    .action((opts: { target: string[] }) => {
      void import('../tools/diagnose.js').then(({ cmdCheckNoteTables }) => {
        void cmdCheckNoteTables(diagnoseCfg(getConfigDir, loadConfig), opts.target);
      });
    });
}

function addVerifyAndMigrateCommands(
  diagnose: Command,
  getConfigDir: GetConfigDir,
  loadConfig: LoadConfig,
): void {
  diagnose
    .command('verify-note')
    .description('Gate check for NOTE files: native-table + push dry-run clean')
    .requiredOption(TARGET_OPTION, TARGET_PATHS_OPTION)
    .action((opts: { target: string[] }) => {
      void import('../tools/diagnose.js').then(({ cmdVerifyNote }) => {
        void cmdVerifyNote(diagnoseCfg(getConfigDir, loadConfig), { targets: opts.target });
      });
    });

  diagnose
    .command('migrate-note-tables')
    .description('Find NOTE files still using pipe-text tables and mark for reupload')
    .option('--dry-run', 'Only report targets, do not write metadata')
    .option('--filter <prefix>', PREFIX_OPTION)
    .option('--limit <n>', 'Maximum files to mark in one run', '0')
    .option('--marker <value>', 'Custom marker written into content_hash')
    .action((opts: { dryRun?: boolean; filter?: string; limit: string; marker?: string }) => {
      void import('../tools/diagnose.js').then(({ cmdMigrateNoteTables }) => {
        const cfg = diagnoseCfg(getConfigDir, loadConfig);
        const limit = Number.parseInt(opts.limit, 10);
        void cmdMigrateNoteTables(cfg, {
          ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
          ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
          ...(Number.isFinite(limit) ? { limit } : {}),
          ...(opts.marker !== undefined ? { marker: opts.marker } : {}),
        });
      });
    });
}

export function registerDiagnoseCommands(
  program: Command,
  getConfigDir: GetConfigDir,
  loadConfig: LoadConfig,
): void {
  const diagnose = program.command('diagnose').description('Sync diagnostic tools');
  addBasicDiagnoseCommands(diagnose, getConfigDir, loadConfig);
  addOpsDiagnoseCommands(diagnose, getConfigDir, loadConfig);
  addMaintenanceDiagnoseCommands(diagnose, getConfigDir, loadConfig);
  addHashDiagnoseCommands(diagnose, getConfigDir, loadConfig);
  addForceAndCheckCommands(diagnose, getConfigDir, loadConfig);
  addVerifyAndMigrateCommands(diagnose, getConfigDir, loadConfig);
  addInspectDiagnoseCommands(diagnose, () => diagnoseCfg(getConfigDir, loadConfig));
}
