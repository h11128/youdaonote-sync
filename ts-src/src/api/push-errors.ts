/**
 * Parse Youdao push/create error payloads from thrown HTTP errors or JSON bodies.
 */

export const YOUDAO_DUPLICATE_NAME = '20108';
export const YOUDAO_VERSION_CONFLICT = '211';

export interface YoudaoPushErrorInfo {
  code: string;
  duplicateFileId?: string;
  raw: string;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function errorCodeOf(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '';
}

function fromRecord(record: Record<string, unknown>, raw: string): YoudaoPushErrorInfo | null {
  const code = errorCodeOf(record.error);
  if (!code) return null;
  const dup = record.duplicateFileId;
  return {
    code,
    raw,
    ...(typeof dup === 'string' && dup ? { duplicateFileId: dup } : {}),
  };
}

/** Extract structured error from a thrown Error / HTTP body / JSON result. */
export function parseYoudaoPushError(err: unknown): YoudaoPushErrorInfo | null {
  if (err && typeof err === 'object' && !Array.isArray(err) && !(err instanceof Error)) {
    return fromRecord(err as Record<string, unknown>, JSON.stringify(err));
  }
  let raw = '';
  if (err instanceof Error) raw = err.message;
  else if (typeof err === 'string') raw = err;
  if (!raw) return null;
  const parsed = tryParseJsonObject(raw);
  return parsed ? fromRecord(parsed, raw) : null;
}

/** Throw when a 200 JSON body still carries an error field (except handled codes). */
export function assertPushResultOk(result: Record<string, unknown>): void {
  const info = fromRecord(result, JSON.stringify(result));
  if (!info) return;
  if (info.code === YOUDAO_DUPLICATE_NAME && info.duplicateFileId) return;
  throw new Error(`Youdao push error ${info.code}: ${info.raw.slice(0, 300)}`);
}

export function resolveDuplicateFileId(result: Record<string, unknown>): string | undefined {
  if (errorCodeOf(result.error) !== YOUDAO_DUPLICATE_NAME) return undefined;
  const dup = result.duplicateFileId;
  return typeof dup === 'string' && dup ? dup : undefined;
}
