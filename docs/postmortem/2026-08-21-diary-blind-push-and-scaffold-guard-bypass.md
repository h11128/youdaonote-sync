# 2026-08-21：日记空模版覆盖云端手写正文（复发）— 未验证云端基线盲推 + 门禁被生成物绕过

- **Date**: 2026-08-21
- **Related**: [2026-08-19: diary-empty-template-overwrite-guard](2026-08-19-diary-empty-template-overwrite-guard.md) — 同一故障类的第二次发生，这次是同一个防护本身被绕过，而不是防护缺失。
- **Symptom**: 08-21 18:46 生成的 902 字节空日记模版，在用户于有道 App 手写日记之后，21:39 被 `youdaonote-sync sync --push` 覆盖到云端。有道客户端检测到版本冲突，自动生成 `(冲突笔记)2026年8月21日1.note` 副本，用户手写内容靠这个副本保住，未真正丢失，但触发了近一小时的错误方向排查。
- **Recovery**: 人工从冲突副本合并回正式日记文件；后确认 08-21 22:12→22:29 之间用户又编辑过一次冲突副本，两版内容分叉，需要人工判定取哪版（未自动化，本次留给用户决定）。

## Conclusion

三个独立缺陷叠加：

1. **未验证的云端基线被当作"已同步"**（新根因，rule_11 的延伸）。`cacheCloudFileInfo` 把云端列表的 `file_id` + `cloud_mtime` 直接写入 metadata，但从未下载过那份云端内容。`computeCloudMtimeChanged` 对这类"从未同步过"的行返回 `false`（"云端自基线以来未变"），`classify()` 于是判定 `localModified` 并直接推送——本地当时是空模版，云端是用户刚写的手写内容，被无条件覆盖。
2. **08-19 引入的 `diary-guard.ts` 被生成物内容绕过**。`hasDiaryHandwriting` 把所有非标题行都计入 `totalBodyChars`，而每日模版生成器（`notes/scripts/patch-diary-sections.py` 的 `--checkin-from-pe` / `--plan-from-pe`）写入的打卡清单和 PE 简报本身就有几百字。刚生成的 902 字节空壳被误判为"用户写过东西"，门禁直接放行，从未探测云端。
3. **云端删除最长 24 小时不可见**，且 `diagnose` 命令不提示数据来源是缓存还是全量扫描——真正阻碍排查的是这一条：Hermes agent 反复看到 `diagnose decision` 报告"cloud: exists / synced"，据此判断"文件名不同不该互相阻塞"，却不知道那份快照可能有几小时没更新过。

## Why it happened (Root Causes)

### 1. `computeCloudMtimeChanged` 对never-synced行返回 false 而非 null

`ts-src/src/classify/conditions.ts`：

```typescript
// before
function computeCloudMtimeChanged(cloud, meta): boolean | null {
  if (!cloud || !meta) return null;
  if (meta.cloudMtime > 0) return cloud.mtime > meta.cloudMtime;   // ← 只看数值, 不看是否验证过
  if (meta.cloudMtime === 0) return true;
  return null;
}
```

`meta.cloudMtime` 可能来自 `cacheCloudFileInfo`（扫描时写入，从未下载校验），也可能来自真正下载/上传后的 `recordSync`（`lastSyncAt > 0`）。旧实现不区分这两种来源，只要数值上"没变"就报 `false`。`rules.ts` 里对应 `localHashChanged: true, cloudMtimeChanged: false` 的规则直接判 `localModified`（上传），从不追问这份 `cloud_mtime` 基线本身是否可信。

### 2. `hasDiaryHandwriting` 把生成器自己的输出当成人写的

`ts-src/src/execute/diary-guard.ts` 的 `totalBodyChars` 累加逻辑只跳过标题行和几个固定的模版占位符（`---`、`无`、`（可选）`），没有识别 Progress Engine 每日简报块（`> ...` 引用行）和打卡/计划清单（`- [ ] #931 ...`）——这两类恰恰是模版生成脚本自己写的，不是手写。

### 3. `diagnose` 不报告快照来源；全量扫描间隔 24 小时

`listRecent` 只报告新增/修改，从不报告删除——`applyIncrementalChanges` 因此永远无法从缓存快照里摘除一个云端已删除的文件。`FULL_SCAN_INTERVAL_SECONDS` 原为 24h，且 `diagnose decision` / `diagnose summary` 的输出完全不提示这次分类用的是缓存快照还是刚做的全量扫描——排查者只能凭空猜。

## Fixes Implemented (commit `603768b`, `cf4a9dc`)

### 1. 区分"从未验证"与"验证后未变"

```typescript
// ts-src/src/classify/conditions.ts
function computeCloudMtimeChanged(cloud, meta): boolean | null {
  if (!cloud || !meta) return null;
  if (meta.lastSyncAt <= 0) return null;   // 从未同步过 = 未知, 不是 "未变"
  if (meta.cloudMtime > 0) return cloud.mtime > meta.cloudMtime;
  if (meta.cloudMtime === 0) return true;
  return null;
}
```

`rules.ts` 里 `localHashChanged: true, cloudMtimeChanged: null` 分支从 `localModified` 改判 `cloudModifiedContent`，转入 `refineAllConflicts` 取证路径（真正下载云端内容算 hash，再判定 converged / download / conflict），不再凭猜测推送。

### 2. 日记门禁跳过生成器自己写的行

```typescript
// ts-src/src/execute/diary-guard.ts
const CHECKBOX_ITEM_RE = /^[-*+]\s*\[[ xX]\]/;
const EMPTY_LIST_MARKER_RE = /^[-*+]$/;
function isGeneratedScaffoldLine(line: string): boolean {
  if (line.startsWith('>')) return true;          // PE 简报引用块
  if (CHECKBOX_ITEM_RE.test(line)) return true;    // 打卡/计划复选框
  return EMPTY_LIST_MARKER_RE.test(line);          // 空列表符号
}
```

手写的非复选框列表项（如 `- 昨晚睡得很好`）仍然计数，不受影响。回归测试固定用了 08-21 那份 902 字节原文——在旧实现上确实失败。

### 3. 全量扫描间隔缩到 1 小时；`diagnose` 报告快照来源

`FULL_SCAN_INTERVAL_SECONDS`: 24h → 1h（实测 5732 文件全量扫描 + 分类 24 秒，24h 的缓存收益远小于过期风险）。`diagnose decision` / `diagnose summary` 现在先打印：

```
cloud snapshot: CACHED (last full scan 10 min ago)
  Cloud-side deletions are NOT visible in a cached snapshot.
  Run `youdaonote-sync diagnose reset-cache` to force a full scan.
```

## Still Open

- **两版冲突笔记的合并未自动化**：22:12 和 22:29 用户先后编辑过云端冲突副本，两版内容分叉（各有对方没有的段落），本次是人工判定，未沉淀成脚本或规则。
- **复发信号**：这是同一故障类（"日记同步覆盖手写"）第二次发生，第一次是防护缺失，这次是防护被绕过。按 `implement-review-commit.mdc` 的复发条款，第三次再发生时不应该只补代码 + 复盘，需要一个 Harness 组件（例如：diary-guard 的单测清单里强制包含"用当天真实生成的模版跑一遍"这类 golden-file 回归，或者一条 pre-sync 的 Hook 校验）。本次先记录在案，未新建组件。
