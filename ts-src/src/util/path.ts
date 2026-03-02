/**
 * Path and filename utilities shared by metadata, scan, and execute layers.
 * Keeps dependency direction: no module depends on scan for path logic.
 */

const FILENAME_REPLACE_RE = /[<]/g;
const FILENAME_DELETE_RE = /[\\/":|*?#>\n\r]/g;
const MULTI_SPACE_RE = / {2,}/g;

/**
 * Sanitize a cloud filename for local storage.
 *
 * Rules (matching Python sanitize_filename):
 * - `<` → `_`
 * - `\ / " : | * ? # >` and `\n \r` → delete
 * - Leading/trailing whitespace (including fullwidth space \u3000) → strip
 * - Consecutive spaces → collapse to single
 * - Stem trailing whitespace → strip
 */
export function sanitizeFilename(name: string): string {
  name = name.replace(FILENAME_REPLACE_RE, '_');
  name = name.replace(FILENAME_DELETE_RE, '');
  name = name.trim();
  name = name.replace(MULTI_SPACE_RE, ' ');
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx <= 0) return name.trimEnd();
  const stem = name.slice(0, dotIdx);
  const ext = name.slice(dotIdx);
  return stem.trimEnd() + ext;
}

/**
 * Normalize path separators to forward slash (cross-platform consistency).
 */
export function normalizeSep(p: string): string {
  return p.replace(/\\/g, '/');
}
