import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { uploadToSmms } from './image-upload.js';

const SMMS_UPLOAD_URL = 'https://sm.ms/api/v2/upload';

let mockFetch: ReturnType<typeof vi.fn>;
let mockDownloadImage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  mockDownloadImage = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadToSmms — validation', () => {
  it('throws on empty imageUrl', async () => {
    await expect(uploadToSmms(mockDownloadImage, '', 'token')).rejects.toThrow(
      'imageUrl must not be empty',
    );
    expect(mockDownloadImage).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws on empty token', async () => {
    await expect(
      uploadToSmms(mockDownloadImage, 'https://example.com/img.png', ''),
    ).rejects.toThrow('smmsSecretToken must not be empty');
    expect(mockDownloadImage).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('uploadToSmms — API behavior', () => {
  it('returns error when download fails', async () => {
    mockDownloadImage.mockRejectedValue(new Error('Connection refused'));

    const result = await uploadToSmms(mockDownloadImage, 'https://example.com/img.png', 'token');

    expect(result.url).toBe('');
    expect(result.error).toContain('Failed to download');
    expect(result.error).toContain('Connection refused');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns success when API returns success', async () => {
    mockDownloadImage.mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e]));
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          success: true,
          data: { url: 'https://sm.ms/abc123.png' },
        }),
    });

    const result = await uploadToSmms(
      mockDownloadImage,
      'https://example.com/img.png',
      'Bearer xyz',
    );

    expect(result.url).toBe('https://sm.ms/abc123.png');
    expect(result.error).toBe('');
    expect(mockFetch).toHaveBeenCalledWith(
      SMMS_UPLOAD_URL,
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer xyz' },
      }),
    );
  });

  it('returns url when image_repeated', async () => {
    mockDownloadImage.mockResolvedValue(new Uint8Array([0xff, 0xd8]));
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          code: 'image_repeated',
          images: 'https://sm.ms/duplicate.png',
        }),
    });

    const result = await uploadToSmms(mockDownloadImage, 'https://example.com/same.png', 'token');

    expect(result.url).toBe('https://sm.ms/duplicate.png');
    expect(result.error).toBe('');
  });
});

describe('uploadToSmms — error handling', () => {
  it('returns rate-limit error when code is flood', async () => {
    mockDownloadImage.mockResolvedValue(new Uint8Array([0x89]));
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ code: 'flood' }),
    });

    const result = await uploadToSmms(mockDownloadImage, 'https://example.com/img.png', 'token');

    expect(result.url).toBe('');
    expect(result.error).toContain('20 images/min');
    expect(result.error).toContain('img.png');
  });

  it('returns rate-limit error when fetch throws (non-proxy)', async () => {
    mockDownloadImage.mockResolvedValue(new Uint8Array([0x89]));
    mockFetch.mockRejectedValue(new Error('ECONNRESET'));

    const result = await uploadToSmms(mockDownloadImage, 'https://example.com/img.png', 'token');

    expect(result.url).toBe('');
    expect(result.error).toContain('20 images/min');
  });

  it('returns network error when fetch throws proxy TypeError', async () => {
    mockDownloadImage.mockResolvedValue(new Uint8Array([0x89]));
    const proxyErr = new TypeError('fetch failed: proxy');
    mockFetch.mockRejectedValue(proxyErr);

    const result = await uploadToSmms(mockDownloadImage, 'https://example.com/img.png', 'token');

    expect(result.url).toBe('');
    expect(result.error).toContain('Network error uploading');
    expect(result.error).toContain('proxy');
  });

  it('returns generic error for unknown API failure', async () => {
    mockDownloadImage.mockResolvedValue(new Uint8Array([0x89]));
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          success: false,
          code: 'unknown',
          data: null,
        }),
    });

    const result = await uploadToSmms(mockDownloadImage, 'https://example.com/img.png', 'my-token');

    expect(result.url).toBe('');
    expect(result.error).toContain('Upload');
    expect(result.error).toContain('my-token');
  });
});
