# RFC: 确定性护栏（Deterministic Guardrails）

> **状态**：Phase 1–3 全部完成  
> 创建：2026-04-08 · 更新：2026-07-26  
> 相关代码：[`engine.ts`](../../ts-src/src/engine/engine.ts) · [`guardrails.test.ts`](../../ts-src/src/engine/guardrails.test.ts) · [`store.ts`](../../ts-src/src/metadata/store.ts) · [`helpers-dryrun.ts`](../../ts-src/src/engine/helpers-dryrun.ts)

---

## 1. 背景

对高危同步操作，不能只靠决策表，还需要硬性拦截：批量删除、云端空列表等异常应挂起或中止。

## 2. 目标

1. **删除阈值拦截**：单次同步待删除数超过 N 时挂起，并输出 dry-run 预览  
2. **操作溯源审计**：变更写入 `sync_log` 时带上 `decision_reason` / `policy_version` / `guardrail_checks`  
3. **空列表保护**：云端返回空列表且本地非空时，不执行删除

## 3. 设计

### 3.1 删除阈值拦截

默认 `maxDeletesPerSync = 5`（[`config.example.json`](../../config.example.json) / `config.json`）。超出时：

- `SyncResult.status = 'suspended'`，`reason = 'delete_threshold'`
- 打印 `=== SYNC SUSPENDED ===` 与 dry-run 预览
- 报告写入 `{local_dir}/.local-reports/`，文首标注 SUSPENDED
- CLI 以 exit code `2` 退出

### 3.2 空列表保护

云端为空、本地非空 → `status = 'aborted'`，`reason = 'empty_cloud_response'`，CLI exit code `3`。

### 3.3 操作溯源

| 字段 | 来源 |
|------|------|
| `decision_reason` | classify 规则匹配（如 `rule_N_upload`） |
| `policy_version` | classify 常量（当前 `1.0`） |
| `guardrail_checks` | execute 前 `stampGuardrailChecks()` 写入 JSON |

`MetadataStore.recordSync()` 会把上述字段持久化到 `sync_log`。

## 4. 里程碑

| Phase | 内容 | 状态 |
|-------|------|------|
| 1 | 删除阈值 + 空列表保护 | ✅ |
| 2 | 操作溯源字段写入 sync_log | ✅ |
| 3 | suspended 时 dry-run 预览 + CLI 状态码 | ✅ |

删除传播（`--propagate-deletes` + 本地回收站）是独立能力，已实现。

## 5. 使用说明

- 配置：见 [README 配置](../../README.md#配置single-source-of-truth) 与 [`config.example.json`](../../config.example.json)
- 预览：`npx youdaonote-sync sync --dry-run`
- 报告：`{local_dir}/.local-reports/`
- 环境变量：见 [`.env.example`](../../.env.example)
