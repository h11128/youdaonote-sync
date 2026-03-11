/**
 * Upload images to external image host (SM.MS).
 *
 * Ported from Python src/transfer/image_upload.py
 */

interface UploadResult {
  url: string;
  error: string;
}

const SMMS_UPLOAD_URL = 'https://sm.ms/api/v2/upload';

function rateLimitMsg(imageUrl: string): string {
  return (
    `SM.MS free tier: 20 images/min, 100 images/hour, max 5MB. ` +
    `Upload failed for "${imageUrl}". Image will be downloaded locally instead.`
  );
}

/**
 * Upload an image to sm.ms image hosting service.
 */
export async function uploadToSmms(
  downloadImage: (url: string) => Promise<Uint8Array>,
  imageUrl: string,
  smmsSecretToken: string,
): Promise<UploadResult> {
  if (!imageUrl) throw new Error('imageUrl must not be empty');
  if (!smmsSecretToken) throw new Error('smmsSecretToken must not be empty');

  let imageData: Uint8Array;
  try {
    imageData = await downloadImage(imageUrl);
  } catch (e: unknown) {
    return {
      url: '',
      error: `Failed to download "${imageUrl}": ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  try {
    const formData = new FormData();
    formData.append('smfile', new Blob([imageData]), 'image.png');

    const resp = await fetch(SMMS_UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: smmsSecretToken },
      body: formData,
    });

    return parseSmmsResponse(
      (await resp.json()) as Record<string, unknown>,
      imageUrl,
      smmsSecretToken,
    );
  } catch (e: unknown) {
    if (e instanceof TypeError && String(e).includes('proxy')) {
      return {
        url: '',
        error: `Network error uploading "${imageUrl}" to SM.MS. Error: ${String(e)}`,
      };
    }
    return { url: '', error: rateLimitMsg(imageUrl) };
  }
}

function parseSmmsResponse(
  json: Record<string, unknown>,
  imageUrl: string,
  token: string,
): UploadResult {
  const data = json.data as Record<string, unknown> | undefined;

  const dataUrl = data?.url;
  if (json.success && typeof dataUrl === 'string') return { url: dataUrl, error: '' };
  if (json.code === 'image_repeated' && typeof json.images === 'string')
    return { url: json.images, error: '' };
  if (json.code === 'flood') return { url: '', error: rateLimitMsg(imageUrl) };

  return {
    url: '',
    error:
      `Upload "${imageUrl}" to SM.MS failed. Check image URL or token (${token}). ` +
      `Image will be downloaded locally instead.`,
  };
}
