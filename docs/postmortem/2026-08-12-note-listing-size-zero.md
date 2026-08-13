# 2026-08-12：有道 `.note` 列表 0 B 被当成空文件删掉

- **Date**: 2026-08-12
- **Tasks**: PE `#783`（恢复 8/7–11）；`#788`（Harness 门禁）；前因 `#776`（cron 整篇覆盖 8/11 手写）
- **Symptom**: 用户在有道官方 App 里看不到 8 月 7–11 日日记；本地 `notes` 仓 `.md` 仍在

## Conclusion

官方 App 显示的是云端 `.note`。目录 API 对有正文的 `.note` **几乎总是返回 `size=0`**。上一场收尾把「列表 0 B」当成空壳，删掉了 8/7–11 的真笔记。本地/git 的 `.md` 没丢；App 里像消失了。

## Evidence

| 证据 | 内容 |
|---|---|
| 云端列表 | 8/1–6、8/12 的 `.note` 全部显示 `(0 B)`；8/7–11 的 `.note` 不在列表里 |
| 实收字节 | 8/6 的 `.md` 拉下来 6804 B 且是合法 NOTE JSON；8/7、8/11 的云端 `.md` 实收 0 B |
| 对照 | 用户只报 8/7–11 消失，正好是上一场 `delete-empty-diary-notes.mts` 的目标日期 |
| 分类器 | 空云端 `.md` + 有正文本地仍报 `synced`（只看本地 hash / 云端 mtime，不看实收字节） |

## Why it happened

1. Skill 写了「删掉并行空 `.note`」，但把「空」定义成了目录 `size===0`。
2. 有道列表大小对 `.note` 不可信；所有日子的 `.note` 都显示 0 B。
3. 同步工具把 `.note` 映射成 `.md`，本地 git 以 `.md` 为 SOT，所以本地看起来「还在」。
4. 下载若把 0 字节写回本地，会把日记盖空。本次分类器仍报 synced，所以还没盖上；这是定时炸弹。

## Fixes

| 项 | 验收 |
|---|---|
| `refuseEmptyOverwrite` | 空下载不得覆盖非空本地；`empty-overwrite-guard` 测试 + `downloadFile` 回归 |
| 重建 `.note` | `scripts/restore-diary-notes-from-md.mts` 从本地 `.md` 生成 NOTE JSON 并回传 |
| 危险脚本 | `delete-empty-diary-notes.mts` 改为硬拒绝；检查改走 `inspect-diary-notes.mts`（只报告，不删） |
| Skill / API 文档 | 明确：列表 size=0 ≠ 空；App SOT=`.note`；git SOT=`.md` |
| Harness（`#788`） | 共享 MDC + 全局 HookRule 拦 `delete-empty-diary-notes` / `deleteFile`+日记 `.note`；youdao-sync skill Hard safety。复盘：notes `docs/retrospectives/2026-08-12-youdao-listing-size-harness.md` |

## Avoidance

- 判断空文件只看 `getFileById` 实收字节（以及 NOTE JSON 的 children），不看列表 size。
- 不要为了「去重」删官方 App 还在用的 `.note`。
- 同步下载前必须拒绝「空内容盖非空本地」。

## Restore command

```bash
cd E:/Projects/youdaonote-sync/ts-src
npx tsx scripts/restore-diary-notes-from-md.mts \
  2026-08-07 2026-08-08 2026-08-09 2026-08-10 2026-08-11
npx tsx scripts/inspect-diary-notes.mts 2026年8月7日
```
