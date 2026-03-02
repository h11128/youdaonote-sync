import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const IMAGE_URL_RE = /!\[.*?\]\((.*?note\.youdao\.com.*?)\)/g;
const ATTACH_URL_RE = /\[(.*?)\]\(((https?):\/\/note\.youdao\.com.*?)\)/g;

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
  } catch {
    return null;
  }
}

/**
 * Rewrite Youdao image/attachment URLs in a Markdown file to local paths.
 */
export async function migrateImages(
  filePath: string,
  imagesDir: string,
  attachDir: string,
  headers: Record<string, string>,
): Promise<number> {
  if (!existsSync(filePath)) return 0;
  let content = readFileSync(filePath, 'utf-8');
  let count = 0;

  const imageMatches = [...content.matchAll(IMAGE_URL_RE)];
  for (const match of imageMatches) {
    const url = match[1]!;
    const localPath = await downloadAsset(url, imagesDir, headers);
    if (localPath) {
      content = content.replace(url, localPath);
      count++;
    }
  }

  const attachMatches = [...content.matchAll(ATTACH_URL_RE)];
  for (const match of attachMatches) {
    const url = match[2]!;
    const localPath = await downloadAsset(url, attachDir, headers);
    if (localPath) {
      content = content.replace(url, localPath);
      count++;
    }
  }

  if (count > 0) writeFileSync(filePath, content, 'utf-8');
  return count;
}
