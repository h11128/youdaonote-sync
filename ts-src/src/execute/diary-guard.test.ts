import { describe, expect, it, vi } from 'vitest';
import { hasDiaryHandwriting, isDiaryName, refuseEmptyDiaryUpload } from './diary-guard.js';
import type { FileId } from '../types/common.js';
import type { YoudaoNoteApi } from '../api/client.js';
import { markdownToNoteJson } from '../convert/md-to-note.js';

describe('diary-guard: isDiaryName', () => {
  it('identifies diary names correctly', () => {
    expect(isDiaryName('2026年8月18日.md')).toBe(true);
    expect(isDiaryName('2026年8月18日.note')).toBe(true);
    expect(isDiaryName('2026年12月31日.md')).toBe(true);
    expect(isDiaryName('2026年1月1日.md')).toBe(true);
    expect(isDiaryName('2026年8月18日')).toBe(true);
    expect(isDiaryName('other.md')).toBe(false);
    expect(isDiaryName('日记模板.md')).toBe(false);
  });
});

describe('diary-guard: hasDiaryHandwriting', () => {
  it('returns false for empty template shell', () => {
    const template = `
# 周二甲子

# **睡眠质量**

# **情绪/状态**

# **感情/人际关系**

# **工作概括**

# **生活概括**

# 主线工作
`;
    expect(hasDiaryHandwriting(template)).toBe(false);
  });

  it('returns false for template with boilerplate placeholders', () => {
    const templateWithPlaceholders = `
# 周二甲子
# **睡眠质量**
（可选）
# **情绪/状态**
无
# **工作概括**
---
`;
    expect(hasDiaryHandwriting(templateWithPlaceholders)).toBe(false);
  });

  it('returns true when protected sections have content', () => {
    const withHandwriting = `
# 周二甲子

# **睡眠质量**
昨晚睡得很好，大概11点睡7点起。

# **情绪/状态**
心情平静充实。

# **感情/人际关系**

# **工作概括**
完成了有道同步算法的重构与安全门禁。

# **生活概括**
晚上去散步了30分钟。

# 主线工作
`;
    expect(hasDiaryHandwriting(withHandwriting)).toBe(true);
  });

  it('handles non-bold headings', () => {
    const withPlainHeadings = `
# 睡眠质量
睡了8小时。

# 工作概括
写代码。
`;
    expect(hasDiaryHandwriting(withPlainHeadings)).toBe(true);
  });

  it('returns true when substantive text exists under other headings', () => {
    const otherSectionText = `
# 2026年8月18日
# 今日随笔
今天和同事讨论了分布式系统的存储方案，收获很大，记录如下：
1. 元数据一致性保障
2. 读写分离缓存设计
`;
    expect(hasDiaryHandwriting(otherSectionText)).toBe(true);
  });
});

describe('diary-guard: refuseEmptyDiaryUpload - allowed cases', () => {
  it('allows upload when local diary has handwriting', async () => {
    const localContent = `
# 睡眠质量
睡了7小时。
# 工作概括
完成任务。
`;
    const api = {
      getFileById: vi.fn(),
    } as unknown as YoudaoNoteApi;

    await expect(
      refuseEmptyDiaryUpload({
        api,
        fileId: 'WEB-123' as FileId,
        name: '2026年8月18日.note',
        localContent,
      }),
    ).resolves.not.toThrow();

    expect(api.getFileById).not.toHaveBeenCalled();
  });

  it('allows upload for non-diary files even if empty', async () => {
    const api = {
      getFileById: vi.fn(),
    } as unknown as YoudaoNoteApi;

    await expect(
      refuseEmptyDiaryUpload({
        api,
        fileId: 'WEB-123' as FileId,
        name: 'readme.md',
        localContent: '',
      }),
    ).resolves.not.toThrow();

    expect(api.getFileById).not.toHaveBeenCalled();
  });

  it('allows upload when both local and cloud are empty shells', async () => {
    const emptyLocalTemplate = `
# 周二甲子
# **睡眠质量**
# **情绪/状态**
`;
    const emptyCloudTemplate = `
# 周二甲子
# **睡眠质量**
# **情绪/状态**
`;
    const api = {
      getFileById: vi.fn().mockResolvedValue(new TextEncoder().encode(emptyCloudTemplate).buffer),
    } as unknown as YoudaoNoteApi;

    await expect(
      refuseEmptyDiaryUpload({
        api,
        fileId: 'WEB-123' as FileId,
        name: '2026年8月18日.note',
        localContent: emptyLocalTemplate,
      }),
    ).resolves.not.toThrow();
  });
});

describe('diary-guard: refuseEmptyDiaryUpload - refusal and safety', () => {
  it('refuses upload when local is empty template and cloud has handwriting', async () => {
    const emptyLocalTemplate = `
# 周二甲子
# **睡眠质量**
# **情绪/状态**
# **感情/人际关系**
# **工作概括**
# **生活概括**
`;
    const cloudNoteContent = `
# 周二甲子
# **睡眠质量**
昨晚睡得很好。
# **情绪/状态**
很好。
# **工作概括**
完成手写日记。
`;
    const api = {
      getFileById: vi.fn().mockResolvedValue(new TextEncoder().encode(cloudNoteContent).buffer),
    } as unknown as YoudaoNoteApi;

    await expect(
      refuseEmptyDiaryUpload({
        api,
        fileId: 'WEB-123' as FileId,
        name: '2026年8月18日.note',
        localContent: emptyLocalTemplate,
      }),
    ).rejects.toThrow(/REFUSE: local diary "2026年8月18日.note" is an empty template shell/);

    expect(api.getFileById).toHaveBeenCalledWith('WEB-123');
  });

  it('refuses upload when cloud note is JSON format with handwriting', async () => {
    const emptyLocalTemplate = `
# 2026年8月18日
# **睡眠质量**
# **工作概括**
`;
    const cloudMd = `
# 2026年8月18日
# **睡眠质量**
昨晚睡眠质量极佳，沉睡了8小时。
# **工作概括**
完成了系统设计。
`;
    const noteJson = markdownToNoteJson(cloudMd);

    const api = {
      getFileById: vi.fn().mockResolvedValue(new TextEncoder().encode(noteJson).buffer),
    } as unknown as YoudaoNoteApi;

    await expect(
      refuseEmptyDiaryUpload({
        api,
        fileId: 'WEB-123' as FileId,
        name: '2026年8月18日.note',
        localContent: emptyLocalTemplate,
      }),
    ).rejects.toThrow(/REFUSE: local diary "2026年8月18日.note" is an empty template shell/);
  });

  it('fails closed on probe API errors (network failure)', async () => {
    const emptyLocalTemplate = `
# 2026年8月18日
# **睡眠质量**
# **工作概括**
`;
    const api = {
      getFileById: vi.fn().mockRejectedValue(new Error('Network ETIMEDOUT')),
    } as unknown as YoudaoNoteApi;

    await expect(
      refuseEmptyDiaryUpload({
        api,
        fileId: 'WEB-123' as FileId,
        name: '2026年8月18日.note',
        localContent: emptyLocalTemplate,
      }),
    ).rejects.toThrow(/probe of cloud note \(WEB-123\) failed/);
  });
});
