import { existsSync, statSync } from 'node:fs';

/**
 * Youdao directory listings often report size=0 for rich `.note` files that
 * still have content. Downloads can also convert to an empty string.
 * Never replace a non-empty local file with empty bytes.
 */
export function refuseEmptyOverwrite(opts: {
  localPath: string;
  markdown: string | null;
  raw: Uint8Array;
}): void {
  if (!existsSync(opts.localPath)) return;
  const localSize = statSync(opts.localPath).size;
  if (localSize <= 0) return;
  const outLen =
    opts.markdown !== null ? Buffer.byteLength(opts.markdown.trim(), 'utf8') : opts.raw.length;
  if (outLen > 0) return;
  throw new Error(
    `REFUSE: empty download would overwrite non-empty local (${localSize} bytes): ${opts.localPath}`,
  );
}
