import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';

const { serverRef } = vi.hoisted(() => {
  const ref = { current: null as Server | null };
  return { serverRef: ref };
});

vi.mock('../api/client.js', () => ({
  YoudaoNoteApi: vi.fn().mockImplementation(() => ({
    loginByCookies: vi.fn().mockReturnValue(null),
    getRootId: vi.fn().mockResolvedValue('root-123'),
    getDirInfoById: vi.fn().mockResolvedValue({
      entries: [
        {
          fileEntry: {
            id: 'f1',
            name: 'test.md',
            dir: false,
            size: 100,
            modifyTimeForSort: Date.now(),
          },
        },
        {
          fileEntry: {
            id: 'd1',
            name: 'folder1',
            dir: true,
            size: 0,
            modifyTimeForSort: 0,
          },
        },
      ],
    }),
  })),
}));

vi.mock('../execute/download.js', () => ({
  downloadFile: vi.fn().mockResolvedValue({ localPath: '/tmp/test.md', fileType: 'md' }),
}));

vi.mock('../browse/search.js', () => ({
  searchByName: vi.fn().mockResolvedValue([
    {
      id: 'f1',
      name: 'found.md',
      isDir: false,
      size: 50,
      modifyTime: 1000,
      path: '/found.md',
    },
  ]),
}));

vi.mock('../browse/pull.js', () => ({
  downloadFolder: vi.fn().mockResolvedValue({ total: 5, succeeded: 5, failed: 0 }),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, mkdirSync: vi.fn() };
});

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const origCreate = actual.createServer as (...args: unknown[]) => Server;
  return {
    ...actual,
    createServer: vi.fn((handler: (req: unknown, res: unknown) => void) => {
      const server = origCreate(handler);
      serverRef.current = server;
      return server;
    }),
  };
});

vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

const originalProcessOn = process.on.bind(process);
vi.spyOn(process, 'on').mockImplementation(((
  event: string,
  handler: (...args: unknown[]) => void,
) => {
  if (event === 'SIGINT') return process;
  return originalProcessOn(event, handler);
}) as typeof process.on);

import { startGuiServer } from './server.js';

async function waitForListening(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    if (serverRef.current?.listening) {
      const addr = serverRef.current.address();
      if (addr && typeof addr === 'object' && 'port' in addr) return addr.port;
      throw new Error('Server not bound to port');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Server did not start listening');
}

async function getHtml(port: number, path: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://localhost:${port}${path}`);
  const text = await res.text();
  return { status: res.status, text };
}

async function postJson(
  port: number,
  path: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

const defaultConfig = {
  cookiesPath: '/tmp/cookies.json',
  defaultDownloadDir: '/tmp/downloads',
  port: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  serverRef.current = null;
});

afterEach(async () => {
  if (serverRef.current) {
    await new Promise<void>((resolve) => {
      serverRef.current!.close(() => {
        resolve();
      });
    });
    serverRef.current = null;
  }
});

describe('startGuiServer — HTML and basic API', () => {
  for (const htmlPath of ['/', '/index.html']) {
    it(`GET ${htmlPath} returns HTML with status 200`, async () => {
      startGuiServer(defaultConfig);
      const port = await waitForListening();

      const { status, text } = await getHtml(port, htmlPath);

      expect(status).toBe(200);
      expect(text).toContain('<!DOCTYPE html>');
    });
  }

  it('POST /api/root returns dirId', async () => {
    startGuiServer(defaultConfig);
    const port = await waitForListening();

    const { status, data } = await postJson(port, '/api/root');

    expect(status).toBe(200);
    expect(data).toEqual({ dirId: 'root-123' });
  });

  it('POST /api/dir with dirId returns folders and files', async () => {
    startGuiServer(defaultConfig);
    const port = await waitForListening();

    const { status, data } = await postJson(port, '/api/dir', { dirId: 'dir1' });

    expect(status).toBe(200);
    expect(data).toHaveProperty('folders');
    expect(data).toHaveProperty('files');
    expect((data as { folders: unknown[] }).folders).toHaveLength(1);
    expect((data as { files: unknown[] }).files).toHaveLength(1);
    expect(
      (data as { folders: { id: string; name: string; isDir: boolean }[] }).folders[0],
    ).toEqual(expect.objectContaining({ id: 'd1', name: 'folder1', isDir: true }));
    expect((data as { files: { id: string; name: string; isDir: boolean }[] }).files[0]).toEqual(
      expect.objectContaining({ id: 'f1', name: 'test.md', isDir: false }),
    );
  });

  const missingParamCases = [
    { name: '/api/dir without dirId', path: '/api/dir', body: {}, error: 'dirId required' },
    {
      name: '/api/download without fileId',
      path: '/api/download',
      body: {},
      error: 'fileId required',
    },
    {
      name: '/api/search without keyword',
      path: '/api/search',
      body: {},
      error: 'keyword required',
    },
    {
      name: '/api/set-download-dir without dir',
      path: '/api/set-download-dir',
      body: {},
      error: 'dir required',
    },
  ];

  for (const { name, path, body, error } of missingParamCases) {
    it(`POST ${name} returns error`, async () => {
      startGuiServer(defaultConfig);
      const port = await waitForListening();

      const { status, data } = await postJson(port, path, body);

      expect(status).toBe(500);
      expect(data).toEqual({ error });
    });
  }
});

describe('startGuiServer — download and search', () => {
  it('POST /api/download with fileId returns download result', async () => {
    startGuiServer(defaultConfig);
    const port = await waitForListening();

    const { status, data } = await postJson(port, '/api/download', {
      fileId: 'file-1',
      fileName: 'doc.md',
    });

    expect(status).toBe(200);
    expect(data).toEqual({ path: '/tmp/test.md', type: 'md' });
  });

  it('POST /api/search with keyword returns results', async () => {
    startGuiServer(defaultConfig);
    const port = await waitForListening();

    const { status, data } = await postJson(port, '/api/search', { keyword: 'test' });

    expect(status).toBe(200);
    expect(data).toHaveProperty('results');
    expect((data as { results: unknown[] }).results).toHaveLength(1);
    expect((data as { results: { id: string; name: string; path: string }[] }).results[0]).toEqual(
      expect.objectContaining({ id: 'f1', name: 'found.md', path: '/found.md' }),
    );
  });

  it('POST /api/download-dir returns download dir', async () => {
    startGuiServer(defaultConfig);
    const port = await waitForListening();

    const { status, data } = await postJson(port, '/api/download-dir');

    expect(status).toBe(200);
    expect(data).toEqual({ dir: '/tmp/downloads' });
  });

  it('POST /api/set-download-dir changes and returns new dir', async () => {
    startGuiServer(defaultConfig);
    const port = await waitForListening();

    const { status, data } = await postJson(port, '/api/set-download-dir', {
      dir: '/new/download/path',
    });

    expect(status).toBe(200);
    expect(data).toEqual({ dir: '/new/download/path' });

    const { data: dirData } = await postJson(port, '/api/download-dir');
    expect(dirData).toEqual({ dir: '/new/download/path' });
  });

  it('POST /api/download-folder with dirId returns result', async () => {
    startGuiServer(defaultConfig);
    const port = await waitForListening();

    const { status, data } = await postJson(port, '/api/download-folder', {
      dirId: 'folder-1',
      dirName: 'MyFolder',
    });

    expect(status).toBe(200);
    expect(data).toEqual(
      expect.objectContaining({
        path: expect.stringContaining('MyFolder'),
        total: 5,
        succeeded: 5,
        failed: 0,
      }),
    );
  });

  for (const { method, path } of [
    { method: 'GET', path: '/unknown' },
    { method: 'POST', path: '/api/unknown' },
  ]) {
    it(`${method} ${path} returns 404`, async () => {
      startGuiServer(defaultConfig);
      const port = await waitForListening();

      const res = await fetch(`http://localhost:${port}${path}`, {
        method,
        ...(method === 'POST'
          ? { headers: { 'Content-Type': 'application/json' }, body: '{}' }
          : {}),
      });

      expect(res.status).toBe(404);
    });
  }
});
