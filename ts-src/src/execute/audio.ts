/**
 * Youdao `.audio` notes are JSON metadata (`recordList` + ASR text), not the
 * audio bitstream. Sync used to run them through json-to-md (rich-note schema),
 * which yields an empty string → 0-byte local files. Clip binaries are separate
 * objects downloadable via sync?method=download with fileId=<recordID>.
 */
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { YoudaoNoteApi } from '../api/client.js';
import { asFileId } from '../types/common.js';
import { logger } from '../util/logger.js';
import { pLimit } from '../util/concurrency.js';
import { audioMediaDir } from '../util/audio-paths.js';
import { renameReplace } from '../util/atomic-replace.js';

export { audioMediaDir, isAudioMediaDirName } from '../util/audio-paths.js';

const AUDIO_CLIP_CONCURRENCY = 4;

export interface AudioRecordMeta {
  recordID?: string;
  recordSize?: number;
  recordDuration?: number;
  recordTextContent?: string;
  noteID?: string;
}

export interface AudioNoteMeta {
  version?: string;
  recordList: AudioRecordMeta[];
}

/** True when bytes are a Youdao voice-note JSON document (has recordList). */
export function isAudioNoteJson(data: Uint8Array): boolean {
  const prefix = Buffer.from(data.slice(0, 120)).toString('utf-8').trimStart();
  if (!prefix.startsWith('{')) return false;
  // Require recordList in the prefix so rich-note JSON is never fully parsed.
  if (!prefix.includes('recordList')) return false;
  try {
    const parsed = JSON.parse(Buffer.from(data).toString('utf-8')) as unknown;
    return isAudioNoteObject(parsed);
  } catch {
    return false;
  }
}

export function isAudioNoteObject(value: unknown): value is AudioNoteMeta {
  if (!value || typeof value !== 'object') return false;
  const rec = (value as { recordList?: unknown }).recordList;
  return Array.isArray(rec);
}

export function parseAudioNoteJson(data: Uint8Array): AudioNoteMeta | null {
  try {
    const parsed = JSON.parse(Buffer.from(data).toString('utf-8')) as unknown;
    return isAudioNoteObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clipExtension(data: Uint8Array): string {
  if (data.length >= 4 && data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67) {
    return '.ogg';
  }
  if (data.length >= 3 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
    return '.mp3';
  }
  // AAC ADTS starts with 0xFFF...
  const b1 = data[1];
  if (data.length >= 2 && data[0] === 0xff && b1 !== undefined && (b1 & 0xf0) === 0xf0) {
    return '.aac';
  }
  return '.bin';
}

function clipFileName(index: number, recordID: string, ext: string): string {
  const pad = String(index).padStart(3, '0');
  return `${pad}-${recordID}${ext}`;
}

function isClipForRecord(name: string, recordID: string): boolean {
  // Exact: NNN-<recordID>.ext
  const m = /^(\d{3})-(.+)\.[^.]+$/.exec(name);
  return m !== null && m[2] === recordID;
}

function shouldSkipExisting(
  existing: { size: number } | null,
  recordSize: number | undefined,
): boolean {
  if (!existing) return false;
  if (recordSize != null) return existing.size === recordSize;
  return existing.size > 0;
}

async function downloadOneClip(
  api: YoudaoNoteApi,
  mediaDir: string,
  index: number,
  recordID: string,
): Promise<boolean> {
  const buf = new Uint8Array(await api.getFileById(asFileId(recordID), { convert: false }));
  if (buf.length === 0) {
    logger.warn(`[audio] empty clip for recordID=${recordID}`);
    return false;
  }
  const outPath = join(mediaDir, clipFileName(index, recordID, clipExtension(buf)));
  removeOrphanClips(mediaDir, recordID, outPath);
  atomicWriteFile(outPath, buf);
  return true;
}

/**
 * Download each recordList clip next to the `.audio` metadata file.
 * Skips clips that already exist with matching size (or any non-empty file
 * when recordSize is unknown). Writes via tmp+rename.
 */
export async function downloadAudioRecords(
  audioPath: string,
  api: YoudaoNoteApi,
  opts?: { data?: Uint8Array },
): Promise<number> {
  const raw = opts?.data ?? new Uint8Array(readFileSync(audioPath));
  const note = parseAudioNoteJson(raw);
  if (!note || note.recordList.length === 0) return 0;

  const mediaDir = audioMediaDir(audioPath);
  mkdirSync(mediaDir, { recursive: true });
  const limit = pLimit(AUDIO_CLIP_CONCURRENCY);
  let saved = 0;

  await Promise.all(
    note.recordList.map((rec, index) =>
      limit(async () => {
        const id = typeof rec.recordID === 'string' ? rec.recordID.trim() : '';
        if (!id) {
          logger.warn(`[audio] empty recordID at index=${index}`);
          return;
        }
        if (shouldSkipExisting(findExistingClip(mediaDir, id), rec.recordSize)) return;
        try {
          if (await downloadOneClip(api, mediaDir, index, id)) saved++;
        } catch (e: unknown) {
          logger.warn(`[audio] failed to download recordID=${id}: ${String(e)}`);
        }
      }),
    ),
  );

  if (saved > 0) {
    logger.info(
      `[audio] ${basename(audioPath)}: saved ${saved}/${note.recordList.length} clips → ${basename(mediaDir)}/`,
    );
  }
  return saved;
}

function findExistingClip(
  mediaDir: string,
  recordID: string,
): { size: number; path: string } | null {
  if (!existsSync(mediaDir)) return null;
  try {
    for (const name of readdirSync(mediaDir)) {
      if (!isClipForRecord(name, recordID)) continue;
      const path = join(mediaDir, name);
      return { size: statSync(path).size, path };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Delete other extensions/indexes for the same recordID before writing. */
function removeOrphanClips(mediaDir: string, recordID: string, keepPath: string): void {
  if (!existsSync(mediaDir)) return;
  for (const name of readdirSync(mediaDir)) {
    if (!isClipForRecord(name, recordID)) continue;
    const path = join(mediaDir, name);
    if (path === keepPath) continue;
    try {
      unlinkSync(path);
    } catch {
      /* best-effort */
    }
  }
}

function atomicWriteFile(targetPath: string, data: Uint8Array): void {
  const tmpPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmpPath, data);
  renameReplace(tmpPath, targetPath);
}
