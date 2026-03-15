/**
 * CLI commands for cloud browsing: list, search, download, pull.
 * Extracted from cli.ts to keep file size manageable.
 */

import type { Command } from 'commander';
import { join } from 'node:path';
import { YoudaoNoteApi } from '../api/client.js';
import { formatFileSize } from '../util/utils.js';
import type { DirId } from '../types/common.js';
import type { DirectoryEntry } from '../browse/search.js';

function loginApi(configDir: string): YoudaoNoteApi {
  const api = new YoudaoNoteApi(join(configDir, 'cookies.json'));
  const err = api.loginByCookies();
  if (err) {
    console.error(`Login failed: ${err}`);
    console.error('Run "npx youdaonote-sync login" first.');
    process.exit(1);
  }
  return api;
}

export function registerBrowseCommands(
  program: Command,
  getConfigDir: () => string,
  loadConfig: (dir: string) => { local_dir: string },
): void {
  program
    .command('list')
    .description('List cloud directory contents')
    .option('--path <cloudPath>', 'Cloud directory path to list (default: root)')
    .option('--depth <n>', 'Max recursion depth', '1')
    .action((opts: { path?: string; depth: string }) => {
      void runList(getConfigDir(), opts);
    });

  program
    .command('search')
    .description('Search files/folders by name in the cloud')
    .requiredOption('--name <keyword>', 'Search keyword')
    .option('--type <type>', 'Filter: all | folder | file', 'all')
    .option('--exact', 'Exact match instead of substring')
    .action((opts: { name: string; type: string; exact?: boolean }) => {
      void runSearch(getConfigDir(), opts);
    });

  program
    .command('download')
    .description('Download a file or folder from the cloud by path')
    .requiredOption('--cloud-path <path>', 'Cloud path to download')
    .option('--out <dir>', 'Local output directory', '.')
    .action((opts: { cloudPath: string; out: string }) => {
      void runDownload(getConfigDir(), opts);
    });

  program
    .command('pull')
    .description('Full recursive export from cloud (independent of sync metadata)')
    .option('--dir <path>', 'Local output directory')
    .option('--cloud-dir <path>', 'Only export this cloud subdirectory')
    .action((opts: { dir?: string; cloudDir?: string }) => {
      void runPull(getConfigDir(), loadConfig, opts);
    });
}

async function runList(configDir: string, opts: { path?: string; depth: string }): Promise<void> {
  const api = loginApi(configDir);
  const { getDirectoryEntries, findFolderByPath } = await import('../browse/search.js');
  const { asDirId } = await import('../types/common.js');

  let dirId: DirId = await api.getRootId();
  if (opts.path) {
    const found = await findFolderByPath(api, opts.path);
    if (!found) {
      console.error(`Folder not found: ${opts.path}`);
      process.exit(1);
    }
    dirId = found;
  }

  const ctx: PrintDirCtx = {
    api,
    getEntries: getDirectoryEntries,
    toDirId: asDirId,
    maxDepth: parseInt(opts.depth, 10),
  };
  await printDir(ctx, dirId, '', 0);
}

interface PrintDirCtx {
  api: YoudaoNoteApi;
  getEntries: (api: YoudaoNoteApi, dirId?: DirId) => Promise<DirectoryEntry[]>;
  toDirId: (s: string) => DirId;
  maxDepth: number;
}

async function printDir(ctx: PrintDirCtx, id: DirId, indent: string, cur: number): Promise<void> {
  const entries = await ctx.getEntries(ctx.api, id);
  for (const e of entries) {
    const icon = e.isDir ? '[D]' : '[F]';
    const size = e.isDir ? '' : ` (${formatFileSize(e.size)})`;
    console.log(`${indent}${icon} ${e.name}${size}`);
    if (e.isDir && cur + 1 < ctx.maxDepth) {
      await printDir(ctx, ctx.toDirId(e.id), indent + '  ', cur + 1);
    }
  }
}

async function runSearch(
  configDir: string,
  opts: { name: string; type: string; exact?: boolean },
): Promise<void> {
  const api = loginApi(configDir);
  const { searchByName } = await import('../browse/search.js');
  const results = await searchByName(
    api,
    opts.name,
    opts.type as 'all' | 'folder' | 'file',
    opts.exact ?? false,
  );
  if (results.length === 0) {
    console.log('No results found.');
    return;
  }
  console.log(`Found ${results.length} result(s):\n`);
  for (const r of results) {
    const icon = r.isDir ? '[D]' : '[F]';
    const size = r.isDir ? '' : ` (${formatFileSize(r.size)})`;
    console.log(`${icon} ${r.path}${size}`);
  }
}

async function runDownload(
  configDir: string,
  opts: { cloudPath: string; out: string },
): Promise<void> {
  const api = loginApi(configDir);
  const { findFolderByPath, getDirectoryEntries } = await import('../browse/search.js');
  const { downloadFolder } = await import('../browse/pull.js');
  const { downloadFile } = await import('../execute/download.js');
  const { asFileId, asDirId } = await import('../types/common.js');

  const parts = opts.cloudPath.split('/').filter(Boolean);
  const parentPath = parts.slice(0, -1).join('/');
  const targetName = parts[parts.length - 1];

  const parentId = parentPath ? await findFolderByPath(api, parentPath) : await api.getRootId();

  if (!parentId) {
    console.error(`Parent folder not found: ${parentPath}`);
    process.exit(1);
  }

  const entries = await getDirectoryEntries(api, parentId);
  const target = entries.find((e) => e.name === targetName);
  if (!target) {
    console.error(`Not found in cloud: ${targetName}`);
    process.exit(1);
  }

  if (target.isDir) {
    await downloadFolder(api, asDirId(target.id), join(opts.out, target.name));
  } else {
    const localPath = join(opts.out, target.name);
    await downloadFile(api, asFileId(target.id), localPath);
    console.log(`Downloaded: ${localPath}`);
  }
}

async function runPull(
  configDir: string,
  loadConfig: (dir: string) => { local_dir: string },
  opts: { dir?: string; cloudDir?: string },
): Promise<void> {
  const api = loginApi(configDir);
  const { pullAll } = await import('../browse/pull.js');
  const config = loadConfig(configDir);
  const cfgDir = config.local_dir;
  const localDir = opts.dir ?? (cfgDir ? cfgDir : join(process.cwd(), 'youdaonote-pull'));
  await pullAll(api, localDir, opts.cloudDir);
}
