# 2026-08-19：日记空模版覆盖云端手写真正文事故复盘与防护落地

- **Date**: 2026-08-19
- **Symptom**: 2026-08-18 用户在有道云笔记官方客户端手写的日记内容（22:35–22:54 期间编辑的睡眠质量、情绪状态、工作/生活概括）在 23:10 同步后被覆盖为空白模版，23:23 用户在 App 中发现正文变空。
- **Recovery**: 依赖有道官方桌面端 `backupNote/` 中的 22 个 gzip 快照历史（版本 v0–v17 记录了手写内容），通过 `python scripts/recover-diary-sources.py` 完整找回。

## Conclusion

本次事故的根因是**双向同步引擎在「上传路径」上缺乏对日记手写的防空模版覆盖保护**，叠加**全量扫描时元数据缓存无条件覆写 `cloud_mtime` 导致冲突分类器失效**。

此前系统已有针对「下载路径」的空内容覆盖防护（`refuseEmptyOverwrite`，防止拉取空云端文件冲掉本地有正文的文件），但在「上传路径」上，当本地是一个仅有标题的空日记模版、而云端已存在用户最新手写内容时，引擎直接将空模版推送至云端，导致云端手写被冲掉。

---

## Timeline & Evidence

| 时间 / 版本 | 动作 / 状态 | 证据链 |
|---|---|---|
| **19:23** (v0–v8) | 本地生成初始空模版 | 仅包含大纲标题，受保护区块（睡眠、情绪、感情、工作、生活）无任何正文 |
| **22:35–22:54** (v9–v17) | 用户在官方 App 中手写日记 | 官方 App 持续生成增量快照，各受保护区块均填入真实手写文字 |
| **23:10** (v18–v19) | 定时同步推送空模版覆盖云端 | 本地空模版被上传推送至云端，版本 v18/v19 变为空壳（1387 字符降为 272 字符） |
| **23:23** | 用户在 App 中发现正文消失 | 官方 App 同步到云端空壳版本，页面显示为空白模版 |
| **次日** | 运行恢复脚本找回 | 桌面备份包含全部历史快照，成功从 v17 提取并恢复全量手写正文 |

---

## Why it happened (Root Causes)

### 1. 上传路径缺少空模版覆盖手写防护（Guardrail Gap）
- `empty-overwrite-guard.ts` 仅作用于 `downloadFile`（防止云端空下载洗掉本地非空）。
- `uploadText` 在将本地文件推送到云端时，没有校验「本地是否为空模版」与「云端是否已有实质手写」。
- 当本地持有一个未经填充的日记模版执行推送时，云端的手写正文被无条件覆写。

### 2. 元数据扫描阶段覆盖 `cloud_mtime` 导致冲突降级为单向上传（Classification Masking）
- `ts-src/src/metadata/store-files.ts` 中的 `cacheCloudFileInfo()` 在 `ON CONFLICT` 子句中原本无条件执行：
  ```sql
  cloud_mtime = excluded.cloud_mtime
  ```
- 当全量扫描运行 `saveScanVersion()` 时，在 `classifyAll()` 执行之前，数据库里的 `files.cloud_mtime` 就已被提前更新为云端最新时间戳。
- 分类器 `classify()` 对比 `meta.cloudMtime` 与 `cloudSnap.mtime` 时发现两者一致，误判为 `cloudMtimeChanged: false`。
- 如果本地文件 mtime 较新，文件被错误归类为普通 `localModified`（单向上传）而非 `conflict`（触发 diff3 合并或产生冲突备份），导致绕过了冲突保护机制。

---

## Fixes Implemented

### 1. 建立日记上传前置守卫（`diary-guard.ts`）
在 `ts-src/src/execute/diary-guard.ts` 中实现专属防护层：
- **日记名称判定**：精确匹配 `YYYY年MM月DD日.md` / `.note`。
- **手写正文检测**（`hasDiaryHandwriting`）：解析 Markdown 各级标题，重点检查受保护核心区块；保护区块正文 ≥10 字符，或任意区块合计 ≥8 字符，判定为含有真实手写。
- **上传强阻断**（`refuseEmptyDiaryUpload`）：对于既有笔记的更新上传（`!isCreate`），若本地被识别为空模版，则主动拉取云端正文；一旦检测到云端存在手写正文，立即抛出致命拒绝错误。守卫始终使用 **markdown 原文**（`diaryGuardMarkdown`），从不把 NOTE JSON 当正文检测。

```typescript
// ts-src/src/execute/diary-guard.ts
export async function refuseEmptyDiaryUpload(opts: {
  api: YoudaoNoteApi;
  fileId: FileId;
  name: string;
  localContent: string;
}): Promise<void> {
  if (!isDiaryName(opts.name)) return;
  if (hasDiaryHandwriting(opts.localContent)) return;

  // Local diary is an empty shell. Probe cloud note content before overwriting.
  let cloudBuf: ArrayBuffer | null;
  try {
    cloudBuf = await opts.api.getFileById(opts.fileId);
  } catch (err: unknown) {
    throw new Error(
      `REFUSE: local diary "${opts.name}" is an empty template shell, and probe of cloud note (${opts.fileId}) failed (${err instanceof Error ? err.message : String(err)}). Upload blocked for safety.`,
    );
  }

  if (!cloudBuf || cloudBuf.byteLength === 0) return;

  const raw = new Uint8Array(cloudBuf);
  const ext = extname(opts.name) || '.note';
  const fileType = detectFileType(raw, ext);
  const cloudText = convertToMarkdown(raw, fileType) ?? Buffer.from(raw).toString('utf-8');

  if (hasDiaryHandwriting(cloudText)) {
    throw new Error(
      `REFUSE: local diary "${opts.name}" is an empty template shell, but cloud note has handwritten content. Refusing upload to prevent overwriting cloud handwriting.`,
    );
  }
}
```

### 2. 接入上传执行链路（`upload.ts` + `upload-push.ts`）
在 `uploadText` 向 `pushWithRecovery` 传入 `diaryGuardMarkdown`（markdown 原文）。`pushOnce` 在每次 `!isCreate` 推送前运行守卫，覆盖正常更新与 20108/211 降级为 update 的恢复路径。

### 3. 修复元数据扫描的 `cloud_mtime` 保留逻辑（`store-files.ts`）
修正 `cacheCloudFileInfo` 的更新逻辑：对于已同步过的文件（`files.last_sync_at > 0`），保留其历史基线 `cloud_mtime`，防止在扫描阶段提前抹平时间差，确保 `classifyAll()` 能正确捕捉云端变更并进入冲突处理流程。

```sql
cloud_mtime = CASE WHEN files.last_sync_at > 0 THEN files.cloud_mtime ELSE excluded.cloud_mtime END
```

### 4. 完善单元测试与端到端验证
- 新增 `ts-src/src/execute/diary-guard.test.ts`（包含日记正则匹配、手写正文解析、空模版拦截等 8 项单元测试）。
- 验证全量 78 个测试套件、915 项测试全部通过（`npm test` 0 failure）。

---

## Invariants & Future Avoidance (MUST)

1. **双向防空（Bi-directional Empty Guards）**：
   - 下传：`refuseEmptyOverwrite` 阻断空云端覆盖非空本地。
   - 上传：`refuseEmptyDiaryUpload` 阻断本地空日记模版覆盖云端手写正文。
2. **分类器基线不可提前抹平**：
   - 全量扫描与缓存水合不得提前修改未完成分类比较的 `files.cloud_mtime`。
3. **日常日记更新脚本先同步后打补丁**：
   - 外部工作流修改日记必须使用区块级合并（`patch-diary-sections.py`），严禁使用全量空模版文件直接覆盖本地文件后再同步。
