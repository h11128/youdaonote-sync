/**
 * Guardrail for diary note uploads.
 * Refuses to overwrite a cloud diary note that has handwriting with an empty local template shell.
 */
import { extname } from 'node:path';
import { detectFileType, convertToMarkdown } from './download.js';
import type { FileId } from '../types/common.js';
import type { YoudaoNoteApi } from '../api/client.js';

const DIARY_STEM_RE = /^\d{4}年\d{1,2}月\d{1,2}日(?:\.(?:md|note))?$/;

export function isDiaryName(name: string): boolean {
  return DIARY_STEM_RE.test(name);
}

const PROTECTED_HEADINGS = [
  '睡眠质量',
  '情绪/状态',
  '感情/人际关系',
  '工作概括',
  '生活概括',
  '今日概括',
  '主线工作',
];

const TEMPLATE_BOILERPLATE = new Set([
  '---',
  '***',
  '___',
  '（可选）',
  '(可选)',
  '*无*',
  '无',
  '暂无',
]);

/**
 * Check if a diary markdown text has non-empty body under protected sections
 * or substantive non-template text.
 */
export function hasDiaryHandwriting(text: string): boolean {
  const lines = text.split('\n');
  let currentProtected: string | null = null;
  let protectedChars = 0;
  let totalBodyChars = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (line.startsWith('#')) {
      const cleanHeading = line.replace(/^[#\s*]+|[*\s]+$/g, '').trim();
      const isProtected = PROTECTED_HEADINGS.some((h) => cleanHeading.includes(h));
      currentProtected = isProtected ? cleanHeading : null;
      continue;
    }

    if (TEMPLATE_BOILERPLATE.has(line)) continue;

    totalBodyChars += line.length;
    if (currentProtected) {
      protectedChars += line.length;
    }

    if (protectedChars > 5 || totalBodyChars > 20) {
      return true;
    }
  }

  return protectedChars > 0;
}

/**
 * Refuse upload if local diary is an empty shell but cloud note already has handwriting.
 * Fails closed on probe/conversion errors to prevent accidental overwrites during network blips.
 */
export async function refuseEmptyDiaryUpload(opts: {
  api: YoudaoNoteApi;
  fileId: FileId;
  name: string;
  localContent: string;
}): Promise<void> {
  if (!isDiaryName(opts.name)) return;
  if (hasDiaryHandwriting(opts.localContent)) return;

  // Local diary is an empty shell. Probe cloud note content before overwriting.
  let cloudBuf: ArrayBuffer;
  try {
    cloudBuf = await opts.api.getFileById(opts.fileId);
  } catch (err: unknown) {
    throw new Error(
      `REFUSE: local diary "${opts.name}" is an empty template shell, and probe of cloud note (${opts.fileId}) failed (${err instanceof Error ? err.message : String(err)}). Upload blocked for safety.`,
      { cause: err },
    );
  }

  if (cloudBuf.byteLength === 0) return;

  const raw = new Uint8Array(cloudBuf);
  const ext = extname(opts.name) || '.note';
  const fileType = detectFileType(raw, ext);
  const cloudText = convertToMarkdown(raw, fileType) ?? Buffer.from(raw).toString('utf-8');

  if (hasDiaryHandwriting(cloudText)) {
    throw new Error(
      `REFUSE: local diary "${opts.name}" is an empty template shell, but cloud note has handwritten content. Refusing upload to prevent overwriting cloud handwriting.`,
    );
  }
}
