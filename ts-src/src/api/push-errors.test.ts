import { describe, expect, it } from 'vitest';
import {
  assertPushResultOk,
  parseYoudaoPushError,
  resolveDuplicateFileId,
  YOUDAO_DUPLICATE_NAME,
  YOUDAO_VERSION_CONFLICT,
} from './push-errors.js';

describe('parseYoudaoPushError', () => {
  it('parses HTTP 500 error messages with JSON body', () => {
    const msg =
      'HTTP 500: {"error":"20108","duplicateFileId":"WEBdup","message":"Message[CLIENT : DUPLICATE_FILE_NAME]"}';
    const info = parseYoudaoPushError(new Error(msg));
    expect(info?.code).toBe(YOUDAO_DUPLICATE_NAME);
    expect(info?.duplicateFileId).toBe('WEBdup');
  });

  it('parses version conflict', () => {
    const info = parseYoudaoPushError(
      new Error('HTTP 500: {"error":"211","message":"Message[VERSION_CONFLICT]"}'),
    );
    expect(info?.code).toBe(YOUDAO_VERSION_CONFLICT);
  });

  it('parses plain result objects', () => {
    const info = parseYoudaoPushError({ error: '20108', duplicateFileId: 'x' });
    expect(info?.duplicateFileId).toBe('x');
  });
});

describe('assertPushResultOk / resolveDuplicateFileId', () => {
  it('allows 20108 with duplicateFileId', () => {
    expect(() => {
      assertPushResultOk({ error: '20108', duplicateFileId: 'WEBdup' });
    }).not.toThrow();
    expect(resolveDuplicateFileId({ error: '20108', duplicateFileId: 'WEBdup' })).toBe('WEBdup');
  });

  it('throws on other error codes', () => {
    expect(() => {
      assertPushResultOk({ error: '301', message: 'bad' });
    }).toThrow(/301/);
  });

  it('passes clean results', () => {
    expect(() => {
      assertPushResultOk({ entry: { id: 'ok' } });
    }).not.toThrow();
  });
});
