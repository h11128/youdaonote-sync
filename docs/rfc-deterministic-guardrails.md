# RFC: 确定性护栏（Deterministic Guardrails）

> 状态：Draft — 尚未实现  
> 创建时间：2026-04-08  
> 最后更新：2026-04-15  
> 作者：Jason (via Cursor)  
> 动机来源：[Claude Code 分析 §2.3](../../myforge/docs/claude-code-leak-analysis.md)

---

## 1. 背景

Claude Code 源码揭示了一个关键设计：对高危操作不信任模型的承诺，而是用硬编码的 `PreToolUse` 钩子做确定性拦截。

youdaonote-sync 作为直接操作用户笔记数据的工具，最需要这种防御性设计。当前的同步决策采用规则表（classify → refine），冲突时按方向做 fallback，但没有针对"批量删除"或"大规模覆盖"等异常场景的硬性拦截。

## 2. 目标

1. **删除阈值拦截**：单次同步计算出需要删除超过 N 个文件时，自动挂起，转为 dry-run 模式
2. **操作溯源审计**：每次变更追加 `decision_reason` 和 `policy_version`，让同步决策完全可追溯
3. **空列表保护**：云端 API 返回空文件列表时，不执行任何删除（防止 API 异常导致全量删除）

## 3. 设计

### 3.1 删除阈值拦截

在 sync pipeline 的 execute 阶段前增加检查：

```typescript
const pendingDeletes = actions.filter(a => a.type === 'delete');
if (pendingDeletes.length > config.maxDeletesPerSync) {
  logger.warn(`Threshold exceeded: ${pendingDeletes.length} deletes, limit ${config.maxDeletesPerSync}`);
  return { status: 'suspended', reason: 'delete_threshold', pendingDeletes };
}
```

默认阈值：`maxDeletesPerSync = 5`，可在 config 中覆盖。

### 3.2 空列表保护

```typescript
if (cloudFiles.length === 0 && localFiles.length > 0) {
  logger.error('Cloud returned empty list but local has files — aborting sync');
  return { status: 'aborted', reason: 'empty_cloud_response' };
}
```

### 3.3 操作溯源

在 `sync_log` 表中新增字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `decision_reason` | TEXT | "local_mtime_newer", "cloud_hash_changed", "conflict_fallback_pull" 等 |
| `policy_version` | TEXT | 当前规则表版本标识 |
| `guardrail_checks` | TEXT | JSON: 哪些护栏检查通过/跳过 |

## 4. 里程碑

| Phase | 内容 | 产出 | 状态 |
|---|---|---|---|
| 1 | 删除阈值 + 空列表保护 | guardrails 模块 | ⬜ Not started |
| 2 | 操作溯源字段 | sync_log schema 变更 | ⬜ Not started |
| 3 | dry-run 增强（suspended 时自动输出 diff 预览） | CLI 输出 | ⬜ Not started |

注：删除传播功能（`--propagate-deletes`）已在架构审查 Phase 6 中实现（含回收站机制），
但本 RFC 的**阈值拦截**和**审计溯源**是独立的安全层，尚未开始。
