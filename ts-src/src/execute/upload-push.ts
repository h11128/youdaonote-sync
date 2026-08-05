/**
 * Push with recovery for Youdao duplicate-name (20108) and version-conflict (211).
 */
import type { YoudaoNoteApi } from '../api/client.js';
import {
  parseYoudaoPushError,
  YOUDAO_DUPLICATE_NAME,
  YOUDAO_VERSION_CONFLICT,
} from '../api/push-errors.js';
import type { DirId, FileId, NoteDomain } from '../types/common.js';

const MAX_PUSH_RECOVERY_DEPTH = 3;

export type PushOnceOpts =
  | {
      api: YoudaoNoteApi;
      fileId: FileId;
      parentId: DirId;
      name: string;
      isCreate: boolean;
      binary: true;
      fileData: Uint8Array;
    }
  | {
      api: YoudaoNoteApi;
      fileId: FileId;
      parentId: DirId;
      name: string;
      isCreate: boolean;
      binary: false;
      domain: NoteDomain;
      bodyString: string;
    };

async function pushOnce(opts: PushOnceOpts): Promise<Record<string, unknown>> {
  if (opts.binary) {
    return opts.api.pushBinaryFile({
      fileId: opts.fileId,
      parentId: opts.parentId,
      name: opts.name,
      fileData: opts.fileData,
      isCreate: opts.isCreate,
    });
  }
  return opts.api.pushFile({
    fileId: opts.fileId,
    parentId: opts.parentId,
    name: opts.name,
    domain: opts.domain,
    bodyString: opts.bodyString,
    isCreate: opts.isCreate,
  });
}

function resolvedPushFileId(result: Record<string, unknown>, fallback: FileId): FileId {
  const fe = (result.fileEntry ?? result.entry) as Record<string, unknown> | undefined;
  if (fe && Object.prototype.hasOwnProperty.call(fe, 'id')) {
    // Explicit empty id from API is a hard failure — do not fall back to a guessed id.
    return typeof fe.id === 'string' && fe.id ? (fe.id as FileId) : ('' as FileId);
  }
  return fallback;
}

function duplicateIdOf(result: Record<string, unknown>): string | undefined {
  return typeof result.duplicateFileId === 'string' ? result.duplicateFileId : undefined;
}

/** Push once, recovering 20108 (reuse id + update) and 211 (retry update). */
export async function pushWithRecovery(
  opts: PushOnceOpts,
  depth = 0,
): Promise<{ fileId: FileId; result: Record<string, unknown> }> {
  if (depth > MAX_PUSH_RECOVERY_DEPTH) {
    throw new Error(`push recovery exceeded ${MAX_PUSH_RECOVERY_DEPTH} retries`);
  }
  try {
    const result = await pushOnce(opts);
    const dupId = duplicateIdOf(result);
    if (dupId && dupId !== opts.fileId) {
      return await pushWithRecovery(
        { ...opts, fileId: dupId as FileId, isCreate: false },
        depth + 1,
      );
    }
    return { fileId: resolvedPushFileId(result, opts.fileId), result };
  } catch (err: unknown) {
    return await recoverPushError(err, opts, depth);
  }
}

async function recoverPushError(
  err: unknown,
  opts: PushOnceOpts,
  depth: number,
): Promise<{ fileId: FileId; result: Record<string, unknown> }> {
  const info = parseYoudaoPushError(err);
  if (info?.code === YOUDAO_DUPLICATE_NAME && info.duplicateFileId) {
    return await pushWithRecovery(
      { ...opts, fileId: info.duplicateFileId as FileId, isCreate: false },
      depth + 1,
    );
  }
  if (info?.code === YOUDAO_VERSION_CONFLICT) {
    return await pushWithRecovery({ ...opts, isCreate: false }, depth + 1);
  }
  throw err;
}
