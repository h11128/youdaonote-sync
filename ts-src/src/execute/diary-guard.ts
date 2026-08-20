/**
 * Guardrail for diary note uploads.
 * Refuses to overwrite a cloud diary note that has handwriting with an empty local template shell.
 */
import { extname } from 'node:path';
import { detectFileType, convertToMarkdown } from './download.js';
import type { FileId } from '../types/common.js';
import type { YoudaoNoteApi } from '../api/client.js';

const DIARY_STEM_RE = /^\d{4}年\d{1,2}月\d{1,2}日(?:\.(?:md|note))?$/;

/** Minimum chars in protected sections to count as local handwriting. */
const MIN_PROTECTED_CHARS = 10;
/** Minimum total body chars (any section) to count as local handwriting. */
const MIN_TOTAL_BODY_CHARS = 8;

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

function isBoilerplateLine(line: string): boolean {
  if (TEMPLATE_BOILERPLATE.has(line)) return true;
  const trimmed = line.replace(/\s+/g, '');
  return trimmed === '*无*' || trimmed === '无';
}

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

    if (isBoilerplateLine(line)) continue;

    totalBodyChars += line.length;
    if (currentProtected) {
      protectedChars += line.length;
    }
  }

  return protectedChars >= MIN_PROTECTED_CHARS || totalBodyChars >= MIN_TOTAL_BODY_CHARS;
}

function cloudMarkdownFromBytes(raw: Uint8Array, name: string): string {
  const ext = extname(name) || '.note';
  let fileType = detectFileType(raw, ext);
  if (fileType === 'binary') {
    const prefix = Buffer.from(raw.slice(0, 50)).toString('utf-8').trimStart();
    if (prefix.startsWith('#') || prefix.startsWith('-')) {
      fileType = 'markdown';
    }
  }
  const markdown = convertToMarkdown(raw, fileType);
  if (markdown != null) return markdown;

  if (fileType === 'markdown') {
    return Buffer.from(raw).toString('utf-8');
  }

  throw new Error(
    `could not convert cloud note bytes (detected ${fileType}) to markdown for handwriting check`,
  );
}

/**
 * Refuse upload if local diary is an empty shell but cloud note already has handwriting.
 * Fails closed on probe/conversion errors to prevent accidental overwrites during network blips.
 * `localContent` must be markdown — never NOTE JSON.
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
  let cloudText: string;
  try {
    cloudText = cloudMarkdownFromBytes(raw, opts.name);
  } catch (err: unknown) {
    throw new Error(
      `REFUSE: local diary "${opts.name}" is an empty template shell, and cloud note (${opts.fileId}) could not be decoded (${err instanceof Error ? err.message : String(err)}). Upload blocked for safety.`,
      { cause: err },
    );
  }

  if (hasDiaryHandwriting(cloudText)) {
    throw new Error(
      `REFUSE: local diary "${opts.name}" is an empty template shell, but cloud note has handwritten content. Refusing upload to prevent overwriting cloud handwriting.`,
    );
  }
}
