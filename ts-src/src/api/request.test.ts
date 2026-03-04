import { describe, expect, it } from 'vitest';
import { safeJson } from './request.js';

describe('safeJson', () => {
  it('returns parsed JSON when response is valid JSON', async () => {
    const resp = new Response(JSON.stringify({ a: 1, b: 'x' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await safeJson(resp);
    expect(data).toEqual({ a: 1, b: 'x' });
  });

  it('throws with status when body is not JSON', async () => {
    const resp = new Response('not json at all', { status: 400 });
    await expect(safeJson(resp)).rejects.toThrow(/API returned non-JSON.*HTTP 400/);
  });

  it('throws when body is empty', async () => {
    const resp = new Response('', { status: 500 });
    await expect(safeJson(resp)).rejects.toThrow(/API returned non-JSON/);
    await expect(safeJson(resp)).rejects.toThrow(/HTTP 500/);
  });
});
