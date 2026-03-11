/**
 * Web-based GUI for Youdao Note management.
 *
 * Replaces the Python Tkinter GUI with a local HTTP server + single-page app.
 * Provides: directory browsing, search, download, and file management.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { formatFileSize } from '../utils.js';
import { YoudaoNoteApi } from '../api/client.js';
import type { DirId, FileId } from '../types/common.js';
import type { DirFileEntry } from '../types/dir.js';
import { downloadFile } from '../execute/download.js';
import { searchByName, type SearchType } from '../browse/search.js';
import { downloadFolder } from '../browse/pull.js';
import { getGuiHtml } from './ui.js';

interface GUIConfig {
  cookiesPath: string;
  defaultDownloadDir: string;
  port?: number;
}

interface FormattedEntry {
  id: string;
  name: string;
  isDir: boolean;
  size: number;
  sizeStr: string;
  modifyTime: number;
  timeStr: string;
  type: string;
}

function formatEntry(fe: DirFileEntry): FormattedEntry {
  const name = fe.name || '(unnamed)';
  const isDir = fe.dir ?? false;
  const mtime = fe.modifyTimeForSort ?? 0;
  const size = fe.size ?? 0;

  return {
    id: fe.id,
    name,
    isDir,
    size,
    sizeStr: size > 0 ? formatFileSize(size) : '-',
    modifyTime: mtime,
    timeStr: mtime > 0 ? new Date(mtime).toISOString().slice(0, 16).replace('T', ' ') : '-',
    type: isDir ? 'folder' : 'file',
  };
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.on('error', reject);
  });
}

type ApiHandler = (body: Record<string, unknown>) => Promise<unknown>;

function buildHandlers(
  api: YoudaoNoteApi,
  state: { downloadDir: string },
): Record<string, ApiHandler> {
  return {
    '/api/root': async () => ({ dirId: await api.getRootId() }),
    '/api/dir': (body) => handleDir(api, body),
    '/api/download': (body) => handleDownloadFile(api, body, state),
    '/api/download-dir': () => Promise.resolve({ dir: state.downloadDir }),
    '/api/set-download-dir': (body) => {
      const dir = body.dir as string;
      if (!dir) throw new Error('dir required');
      state.downloadDir = dir;
      return Promise.resolve({ dir: state.downloadDir });
    },
    '/api/search': (body) => handleSearch(api, body),
    '/api/download-folder': (body) => handleDownloadFolder(api, body, state),
  };
}

async function handleDir(api: YoudaoNoteApi, body: Record<string, unknown>): Promise<unknown> {
  const dirId = body.dirId as DirId;
  if (!dirId) throw new Error('dirId required');
  const info = await api.getDirInfoById(dirId);
  const folders: FormattedEntry[] = [];
  const files: FormattedEntry[] = [];
  for (const e of info.entries ?? []) {
    (e.fileEntry.dir ? folders : files).push(formatEntry(e.fileEntry));
  }
  return { folders, files };
}

async function handleDownloadFile(
  api: YoudaoNoteApi,
  body: Record<string, unknown>,
  state: { downloadDir: string },
): Promise<unknown> {
  const fileId = body.fileId as FileId;
  const fileName = (body.fileName as string) || 'unknown';
  if (!fileId) throw new Error('fileId required');
  const targetDir = typeof body.targetDir === 'string' ? body.targetDir : state.downloadDir;
  mkdirSync(targetDir, { recursive: true });
  const result = await downloadFile(api, fileId, join(targetDir, fileName));
  return { path: result.localPath, type: result.fileType };
}

async function handleSearch(api: YoudaoNoteApi, body: Record<string, unknown>): Promise<unknown> {
  const keyword = body.keyword as string;
  if (!keyword) throw new Error('keyword required');
  const searchType: SearchType =
    (body.type as string) === 'folder' || (body.type as string) === 'file'
      ? (body.type as SearchType)
      : 'all';
  const results = await searchByName(api, keyword, searchType, Boolean(body.exact));
  return {
    results: results.map((r) => ({
      ...formatEntry({
        id: r.id,
        name: r.name,
        dir: r.isDir,
        size: r.size,
        modifyTimeForSort: r.modifyTime,
      }),
      path: r.path,
    })),
  };
}

async function handleDownloadFolder(
  api: YoudaoNoteApi,
  body: Record<string, unknown>,
  state: { downloadDir: string },
): Promise<unknown> {
  const dirId = body.dirId as DirId;
  const dirName = (body.dirName as string) || 'folder';
  if (!dirId) throw new Error('dirId required');
  const targetDir =
    typeof body.targetDir === 'string' ? body.targetDir : join(state.downloadDir, dirName);
  const stats = await downloadFolder(api, dirId, targetDir);
  return { path: targetDir, ...stats };
}

export function startGuiServer(config: GUIConfig): void {
  const port = config.port ?? 3456;
  const api = new YoudaoNoteApi(config.cookiesPath);

  const loginError = api.loginByCookies();
  if (loginError) {
    console.error(`Login failed: ${loginError}`);
    console.error('Run "npx youdaonote-sync login" first.');
    process.exit(1);
  }

  const state = { downloadDir: config.defaultDownloadDir };
  const handlers = buildHandlers(api, state);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getGuiHtml());
      return;
    }

    const handler = req.url ? handlers[req.url] : undefined;
    if (req.method === 'POST' && handler) {
      void handleRequest(req, res, handler);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(`\nYoudao Note GUI started at http://localhost:${port}`);
    console.log(`Download directory: ${state.downloadDir}`);
    console.log('Press Ctrl+C to stop.\n');
  });

  process.on('SIGINT', () => {
    server.close();
    process.exit(0);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handler: ApiHandler,
): Promise<void> {
  try {
    const body = await readBody(req);
    const result = await handler(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (e: unknown) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}
