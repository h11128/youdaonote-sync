import type { Command } from 'commander';
import {
  assertConfigSot,
  ensureConfigSot,
  getConfigDir,
  getLegacyConfigDir,
  inspectConfigSot,
  migrateConfigFiles,
  retireLegacyConfigDir,
} from '../util/config-dir.js';

/** Register `config` and `migrate` commands (single source of truth helpers). */
export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('Inspect the single config directory (SOT)');

  config
    .command('path')
    .description('Print the active config directory path')
    .action(() => {
      console.log(getConfigDir());
    });

  config
    .command('doctor')
    .description('Check for dual-config conflicts and missing files')
    .action(() => {
      const report = inspectConfigSot();
      console.log(report.message);
      console.log('');
      console.log(`SOT:     ${report.configDir} (source=${report.source})`);
      console.log(`Legacy:  ${report.legacyDir}`);
      console.log(`config.json:      ${report.files.configJson ? 'yes' : 'NO'}`);
      console.log(`cookies.json:     ${report.files.cookiesJson ? 'yes' : 'NO'}`);
      console.log(`sync_metadata.db: ${report.files.metadataDb ? 'yes' : 'NO'}`);
      console.log(`conflict:         ${report.conflict ? 'YES' : 'no'}`);
      if (report.conflict) process.exitCode = 1;
      else if (!report.files.configJson) process.exitCode = 2;
    });

  program
    .command('migrate')
    .description('One-shot: copy old repo config/ into the SOT (then retires the old folder)')
    .action(() => {
      const oldDir = getLegacyConfigDir();
      const newDir = getConfigDir();
      console.log(`Migrating: ${oldDir} → ${newDir}`);
      const copied = migrateConfigFiles(oldDir, newDir);
      if (copied.length === 0) {
        console.log('Nothing to migrate (source missing or destination already has files).');
      } else {
        console.log(`Copied: ${copied.join(', ')}`);
      }
      const retired = retireLegacyConfigDir(oldDir);
      if (retired) console.log(`Retired legacy dir → ${retired}`);
      const report = ensureConfigSot();
      if (report.conflict) {
        console.error(report.message);
        process.exitCode = 1;
      } else {
        console.log(report.message);
      }
    });
}

/** Call at the start of sync/login/watch/gui so dual config cannot silently diverge. */
export function requireConfigSot(): void {
  assertConfigSot();
}
