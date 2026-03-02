/**
 * Shared HTTP response helpers for API layer.
 */

export async function safeJson(resp: Response): Promise<Record<string, unknown>> {
  try {
    return await resp.json() as Record<string, unknown>;
  } catch {
    const text = await resp.text().catch(() => '(empty)');
    throw new Error(`API returned non-JSON (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
}
