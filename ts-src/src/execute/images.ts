import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { pLimit } from '../util/concurrency.js';

const IMAGE_URL_RE = /!\[.*?\]\((.*?note\.youdao\.com.*?)\)/g;
const ATTACH_URL_RE = /\[(.*?)\]\(((https?):\/\/note\.youdao\.com.*?)\)/g;
const ASSET_CONCURRENCY = 5;

/**
 * Download an asset (image or attachment) from a URL and save locally.
 */
export async function downloadAsset(
  url: string,
  targetDir: string,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) return null;
    const data = new Uint8Array(await resp.arrayBuffer());

    const urlPath = new URL(url).pathname;
    const filename = urlPath.split('/').pop() ?? 'unknown';
    const localPath = join(targetDir, filename);

    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, data);
    return localPath;
  } catch (e: unknown) {
    console.warn(`[images] failed to download asset ${url}: ${String(e)}`);
    return null;
  }
}

interface AssetMatch {
  url: string;
  targetDir: string;
}

/**
 * Rewrite Youdao image/attachment URLs in a Markdown file to local paths.
 * Downloads assets concurrently with URL dedup.
 */
export async function migrateImages(
  filePath: string,
  imagesDir: string,
  attachDir: string,
  headers: Record<string, string>,
): Promise<number> {
  if (!existsSync(filePath)) return 0;
  let content = readFileSync(filePath, 'utf-8');

  const fileDir = dirname(filePath);

  // Collect all unique URLs
  const seen = new Set<string>();
  const assets: AssetMatch[] = [];

  for (const match of content.matchAll(IMAGE_URL_RE)) {
    const url = match[1] ?? match[2];
    if (url && !seen.has(url)) {
      seen.add(url);
      assets.push({ url, targetDir: imagesDir });
    }
  }
  for (const match of content.matchAll(ATTACH_URL_RE)) {
    const url = match[2] ?? match[1];
    if (url && !seen.has(url)) {
      seen.add(url);
      assets.push({ url, targetDir: attachDir });
    }
  }

  if (assets.length === 0) return 0;

  // Download concurrently with bounded parallelism
  const limit = pLimit(ASSET_CONCURRENCY);
  const results = await Promise.all(
    assets.map((a) =>
      limit(async () => ({
        url: a.url,
        localPath: await downloadAsset(a.url, a.targetDir, headers),
      })),
    ),
  );

  let count = 0;
  for (const { url, localPath } of results) {
    if (localPath) {
      const relPath = relative(fileDir, localPath).replace(/\\/g, '/');
      content = content.replaceAll(url, relPath);
      count++;
    }
  }

  if (count > 0) writeFileSync(filePath, content, 'utf-8');
  return count;
}
