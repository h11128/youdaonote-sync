#!/usr/bin/env npx tsx
/**
 * 真实 API 冒烟测试
 *
 * 用真实 cookie 连接有道笔记服务端，执行完整的 CRUD 流程：
 *   1. 登录（cookie）
 *   2. 获取根目录 ID
 *   3. 创建测试目录
 *   4. 上传测试文件
 *   5. 下载并验证内容
 *   6. 重命名文件
 *   7. 下载重命名后的文件验证
 *   8. 删除测试文件
 *   9. 删除测试目录
 *  10. listRecent 验证
 *
 * 用法:
 *   cd ts-src && npx tsx src/smoke-test.ts
 *   cd ts-src && npx tsx src/smoke-test.ts --keep   # 不清理测试数据
 *
 * 前提:
 *   config/cookies.json 存在且有效（或有道桌面客户端已登录）
 */

import { join } from 'node:path';
import { YoudaoNoteApi } from './api/client.js';
import { NoteDomain } from './types/common.js';
import type { FileId, DirId } from './types/common.js';

const KEEP = process.argv.includes('--keep');
const TEST_DIR_NAME = `_smoke_test_${Date.now()}`;
const TEST_FILE_NAME = 'smoke-test-doc.md';
const TEST_CONTENT = `# Smoke Test\n\nCreated at ${new Date().toISOString()}\n\n这是自动冒烟测试生成的文件。\n`;
const RENAMED_FILE_NAME = 'smoke-test-renamed.md';

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string | undefined;
}

const results: StepResult[] = [];
let createdFileId: FileId | null = null;
let createdDirId: DirId | null = null;

async function step(
  name: string,
  fn: () => Promise<string | undefined> | string | undefined,
): Promise<boolean> {
  const t0 = Date.now();
  try {
    const detail = await Promise.resolve(fn());
    results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? undefined });
    console.log(`  ✅ ${name} (${Date.now() - t0}ms)${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, ms: Date.now() - t0, detail: msg });
    console.log(
      `  ❌ ${name} (${Date.now() - t0}ms) — ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

async function testLogin(api: YoudaoNoteApi): Promise<boolean> {
  return step('1. Cookie 登录', () => {
    const err = api.loginByCookies();
    if (err) throw new Error(err);
    return 'cookie 加载成功';
  });
}

async function testGetRootId(api: YoudaoNoteApi): Promise<DirId | null> {
  let rootId: DirId | null = null;
  const ok = await step('2. 获取根目录 ID', async () => {
    rootId = await api.getRootId();
    return rootId ? `rootId = ${rootId.slice(0, 16)}...` : undefined;
  });
  return ok ? rootId : null;
}

async function testCreateDir(api: YoudaoNoteApi, rootId: DirId): Promise<void> {
  await step('3. 创建测试目录', async () => {
    const result = await api.createDir(rootId, TEST_DIR_NAME);
    const fe = result.fileEntry as Record<string, unknown> | undefined;
    createdDirId = (fe?.id ?? '') as DirId;
    if (!createdDirId) throw new Error('未获取到目录 ID');
    return `dir = ${TEST_DIR_NAME}, id = ${createdDirId.slice(0, 16)}...`;
  });
}

async function testUploadFile(api: YoudaoNoteApi): Promise<void> {
  if (!createdDirId) return;
  const dirId = createdDirId;
  await step('4. 上传测试文件', async () => {
    const fileId = YoudaoNoteApi.generateFileId();
    createdFileId = fileId;
    const result = await api.pushFile({
      fileId,
      parentId: dirId,
      name: TEST_FILE_NAME,
      domain: NoteDomain.MARKDOWN,
      bodyString: TEST_CONTENT,
      isCreate: true,
    });
    const entry = (result.entry ?? result.fileEntry ?? {}) as Record<string, unknown>;
    const mtimeVal = entry.modifyTimeForSort;
    const mtimeStr = typeof mtimeVal === 'number' ? String(mtimeVal) : '';
    return `fileId = ${fileId.slice(0, 16)}..., mtime = ${mtimeStr}`;
  });
}

async function testDownloadVerify(api: YoudaoNoteApi): Promise<void> {
  if (!createdFileId) return;
  const fid = createdFileId;
  await step('5. 下载并验证内容', async () => {
    const raw = await api.getFileById(fid);
    const content = Buffer.from(raw).toString('utf-8');
    if (!content.includes('Smoke Test')) {
      throw new Error(`内容不匹配: 期望包含 "Smoke Test"，实际: "${content.slice(0, 80)}..."`);
    }
    return `${content.length} 字节, 内容匹配 ✓`;
  });
}

async function testRenameFile(api: YoudaoNoteApi): Promise<void> {
  if (!createdFileId) return;
  const fileId = createdFileId;
  await step('6. 重命名文件', async () => {
    await api.renameFile(fileId, RENAMED_FILE_NAME, NoteDomain.MARKDOWN);
    return `${TEST_FILE_NAME} → ${RENAMED_FILE_NAME}`;
  });
}

async function testDownloadRenamed(api: YoudaoNoteApi): Promise<void> {
  if (!createdFileId) return;
  const fileId = createdFileId;
  await step('7. 下载重命名后的文件', async () => {
    const raw = await api.getFileById(fileId);
    const content = Buffer.from(raw).toString('utf-8');
    if (!content.includes('Smoke Test')) throw new Error('重命名后内容丢失');
    return '内容完好 ✓';
  });
}

async function testListRecent(api: YoudaoNoteApi): Promise<void> {
  await step('8. listRecent 获取最近文件', async () => {
    const recent = await api.listRecent(5);
    return `返回 ${recent.length} 条记录`;
  });
}

async function testCleanup(api: YoudaoNoteApi): Promise<void> {
  if (KEEP) {
    console.log(`\n  ⏭ 跳过清理 (--keep)，测试数据保留在云端: ${TEST_DIR_NAME}/`);
    return;
  }
  if (createdFileId) {
    const fid = createdFileId;
    await step('9a. 删除测试文件', async () => {
      await api.deleteFile(fid);
      return `fileId = ${fid.slice(0, 16)}...`;
    });
  }
  if (createdDirId) {
    const did = createdDirId;
    await step('9b. 删除测试目录', async () => {
      await api.deleteFile(did as unknown as FileId);
      return `dirId = ${did.slice(0, 16)}...`;
    });
  }
}

async function main(): Promise<void> {
  const cookiesPath = join(process.cwd(), '..', 'config', 'cookies.json');
  const api = new YoudaoNoteApi(cookiesPath);

  console.log();
  console.log('═'.repeat(60));
  console.log('  有道笔记 API 冒烟测试');
  console.log('═'.repeat(60));
  console.log();

  if (!(await testLogin(api))) {
    printSummary();
    process.exit(1);
  }

  const rootId = await testGetRootId(api);
  if (!rootId) {
    printSummary();
    process.exit(1);
  }

  await testCreateDir(api, rootId);
  await testUploadFile(api);
  await testDownloadVerify(api);
  await testRenameFile(api);
  await testDownloadRenamed(api);
  await testListRecent(api);
  await testCleanup(api);

  printSummary();
  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length > 0 ? 1 : 0);
}

function printSummary(): void {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const totalMs = results.reduce((s, r) => s + r.ms, 0);

  console.log();
  console.log('─'.repeat(60));
  console.log(`  结果: ${passed} 通过, ${failed} 失败, 总耗时 ${totalMs}ms`);

  if (failed > 0) {
    console.log();
    console.log('  失败项:');
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`    ❌ ${r.name}: ${r.detail}`);
    }
  }

  console.log('─'.repeat(60));
  console.log();
}

main().catch((e: unknown) => {
  console.error('冒烟测试异常退出:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
