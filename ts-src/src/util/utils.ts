/**
 * General-purpose utility functions.
 */

/**
 * Format byte count as human-readable string (B / KB / MB / GB).
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * On Windows, prefix long paths (>= 260 chars) with \\\\?\\ to bypass MAX_PATH.
 * On other platforms, returns the path unchanged.
 */
export function safeLongPath(p: string): string {
  if (process.platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\')) return p;
  if (p.length >= 260) return `\\\\?\\${p}`;
  return p;
}
