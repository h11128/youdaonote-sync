import type { Command } from 'commander';

interface DiagnoseConfig {
  cookiesPath: string;
  metadataPath: string;
  localDir: string;
}

type GetDiagnoseCfg = () => DiagnoseConfig;

const TARGET_ONE_OPTION = '--target <path>';

export function addInspectDiagnoseCommands(diagnose: Command, getCfg: GetDiagnoseCfg): void {
  diagnose
    .command('fetch-note')
    .description('Fetch cloud note content by path and optionally save output')
    .requiredOption(TARGET_ONE_OPTION, 'One NOTE file path')
    .option('--output <path>', 'Save fetched content to this relative path')
    .option('--raw', 'Save raw text instead of pretty JSON')
    .action((opts: { target: string; output?: string; raw?: boolean }) => {
      void import('../tools/diagnose.js').then(({ cmdFetchNote }) => {
        void cmdFetchNote(getCfg(), opts);
      });
    });

  diagnose
    .command('compare-note')
    .description('Compare two cloud notes by structure/attrs/raw content')
    .requiredOption('--a <path>', 'First NOTE path')
    .requiredOption('--b <path>', 'Second NOTE path')
    .option('--focus <mode>', 'Compare mode: table|attrs|raw', 'table')
    .action((opts: { a: string; b: string; focus?: 'table' | 'attrs' | 'raw' }) => {
      void import('../tools/diagnose.js').then(({ cmdCompareNote }) => {
        void cmdCompareNote(getCfg(), opts);
      });
    });

  diagnose
    .command('compare-cloud-local')
    .description('Compare local markdown with cloud-downloaded markdown')
    .requiredOption(TARGET_ONE_OPTION, 'One file path to compare')
    .option('--max-diffs <n>', 'Maximum line diffs to print', '8')
    .action((opts: { target: string; maxDiffs?: string }) => {
      void import('../tools/diagnose.js').then(({ cmdCompareCloudLocal }) => {
        const maxDiffs = Number.parseInt(opts.maxDiffs ?? '8', 10);
        void cmdCompareCloudLocal(getCfg(), {
          target: opts.target,
          ...(Number.isFinite(maxDiffs) ? { maxDiffs } : {}),
        });
      });
    });
}
