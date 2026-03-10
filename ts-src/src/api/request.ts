/**
 * Shared HTTP response helpers for API layer.
 */

export async function safeJson(resp: Response): Promise<Record<string, unknown>> {
  const body = await resp.text();
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error(
      `API returned non-JSON (HTTP ${resp.status}): ${(body || '(empty)').slice(0, 200)}`,
    );
  }
}
