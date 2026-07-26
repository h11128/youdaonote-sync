# youdaonote-sync

有道云笔记本地同步工具：把云端笔记同步成 Markdown，支持双向同步、定时监听和 Web 浏览。

- **语言**：[TypeScript](https://www.typescriptlang.org/) / [Node.js](https://nodejs.org/)（需 **18+**，推荐 20+）
- **仓库**：[github.com/h11128/youdaonote-sync](https://github.com/h11128/youdaonote-sync)
- **Issues**：[提交问题](https://github.com/h11128/youdaonote-sync/issues) · [模板](./.github/ISSUE_TEMPLATE/提-issue-请使用这个模版.md)
- **许可**：[MIT](./LICENSE.md)
- **文档索引**：[docs/README.md](./docs/README.md)

## 端到端同步流程（主路径）

整条链路：**安装 → 配置 SOT → 登录 → dry-run → sync**。

### Single source of truth（本地配置只有一处）

运行时**只读一个目录**（SOT），由 [`config-dir.ts`](./ts-src/src/util/config-dir.ts) 解析：

| 优先级 | 来源 |
|--------|------|
| 1 | 环境变量 `YOUDAONOTE_CONFIG_DIR`（可选） |
| 2 | Windows `%APPDATA%\youdaonote-sync\` · macOS/Linux `~/.config/youdaonote-sync/` |

仓库里的 `config/` **不是**运行时配置（已废弃）。若 SOT 与仓库 `config/` **同时**有 `config.json`，`sync` / `login` / `watch` / `diagnose` 会直接失败，避免改错目录。

| 仓库内（仅模板） | 本机 SOT（真实配置，不进 git） |
|------------------|--------------------------------|
| [`config.example.json`](./config.example.json) | `{SOT}/config.json` |
| [`.env.example`](./.env.example) | 可选 `.env`（只覆盖 `YOUDAONOTE_CONFIG_DIR` 等） |
| — | `{SOT}/cookies.json`、`{SOT}/sync_metadata.db` |

```bash
npx youdaonote-sync config path      # 打印 SOT 路径
npx youdaonote-sync config doctor    # 冲突与缺文件检查
npx youdaonote-sync migrate          # 旧 cwd/config/ → SOT（完成后请删除旧目录）
```

```text
[有道云笔记]  ←── {SOT}/cookies.json ──→  youdaonote-sync CLI
                                            │
                   {SOT}/config.json ───────┤
                   {SOT}/sync_metadata.db ──┤
                                            ▼
                                     {local_dir}/*.md
```

### 1. 安装

```bash
git clone https://github.com/h11128/youdaonote-sync.git
cd youdaonote-sync/ts-src
npm install
npm run build
```

可选登录依赖：[Playwright](https://playwright.dev/docs/intro)

```bash
npm install playwright
npx playwright install chromium
```

入口：[bin.ts](./ts-src/src/bin.ts) · 引擎：[engine.ts](./ts-src/src/engine/engine.ts)

### 2. 写入 SOT 配置

```bash
npx youdaonote-sync config path
# 把 config.example.json 复制到上一步打印的目录，命名为 config.json
```

```json
{
  "local_dir": "/path/to/your/notes",
  "is_relative_path": true,
  "maxDeletesPerSync": 5,
  "sync_exclude": ["**/*.log", "**/.trash/**", "**/.local-reports/**"]
}
```

| 字段 | 含义 |
|------|------|
| `local_dir` | 本地笔记根目录（必填） |
| `smms_secret_token` | 可选 [SM.MS token](https://sm.ms/home/apitoken) |
| `maxDeletesPerSync` | 单次最大删除数，默认 `5`（[RFC](./docs/rfc-deterministic-guardrails.md)） |
| `sync_include` / `sync_exclude` | 选择性同步 |

### 3. 登录

```bash
cd ts-src
npx youdaonote-sync login
```

[auth.ts](./ts-src/src/api/auth.ts) 把 Cookie 写入 **SOT**，不是仓库。

### 4. 预览 → 正式同步

```bash
npx youdaonote-sync sync --dry-run
npx youdaonote-sync sync
npx youdaonote-sync sync --push
npx youdaonote-sync sync --pull
npx youdaonote-sync sync --git
npx youdaonote-sync sync --propagate-deletes
```

CLI：[cli.ts](./ts-src/src/cli/cli.ts) · dry-run 报告：`{local_dir}/.local-reports/`

护栏：空云端列表 → abort（exit 3）；删除过多 → suspend（exit 2）。见 [RFC](./docs/rfc-deterministic-guardrails.md)。

### 5. 常驻 / GUI / 诊断（可选）

```bash
npx youdaonote-sync watch --interval 300
npx youdaonote-sync gui
npx youdaonote-sync diagnose summary
npx youdaonote-sync config doctor
```

## 它能做什么

| 能力 | 说明 |
|------|------|
| 双向同步 | 本地 ↔ 云端互相更新 |
| 单向同步 | `--push` / `--pull` |
| 自动同步 | [`watch`](./ts-src/src/engine/watcher.ts) |
| 格式转换 | [`convert/`](./ts-src/src/convert/) |
| 图片 | 本地或 [SM.MS](https://sm.ms/) |
| 去重 / 移动 | [`dedup/`](./ts-src/src/dedup/) · [`moves.ts`](./ts-src/src/classify/moves.ts) |
| 删除保护 | [RFC](./docs/rfc-deterministic-guardrails.md) |
| Git | [`util/git.ts`](./ts-src/src/util/git.ts) |
| Web GUI | [`gui/`](./ts-src/src/gui/) |
| 诊断 | [`diagnose-cli.ts`](./ts-src/src/cli/diagnose-cli.ts) |

## 同步规则（简版）

- 只有本地有 → 上传；元数据曾同步过则视为云端已删，默认不重建
- 只有云端有 → 下载；元数据曾同步过则视为本地已删，默认不重建
- 内容相同 → 跳过（即使 mtime 变了）
- 内容不同 → 尽量单向；否则按较新一侧
- 移动检测：[`moves.ts`](./ts-src/src/classify/moves.ts)
- 删除传播：`--propagate-deletes`

## NOTE 表格诊断

```bash
npx youdaonote-sync diagnose check-note-tables --target "folder/note.md"
npx youdaonote-sync diagnose verify-note --target "folder/note.md"
npx youdaonote-sync diagnose compare-cloud-local --target "folder/note.md"
```

复盘：[note-table-incident-retrospective-2026-03.md](./docs/note-table-incident-retrospective-2026-03.md) · PR 模板：[PULL_REQUEST_TEMPLATE.md](./.github/PULL_REQUEST_TEMPLATE.md)

## Windows 定时同步（可选）

用 [任务计划程序](https://learn.microsoft.com/windows/win32/taskschd/task-scheduler-start-page)，工作目录指向 `ts-src`：

```bat
cd /d C:\path\to\youdaonote-sync\ts-src
npx youdaonote-sync sync --git
```

Git Bash 下 `schtasks` 建议加 `MSYS_NO_PATHCONV=1`。

## 开发

```bash
cd ts-src
npm test
npm run typecheck
npm run lint
npm run format
npm run build
```

| 目录 | 职责 |
|------|------|
| [`api/`](./ts-src/src/api/) | API / 登录 / Cookie |
| [`scan/`](./ts-src/src/scan/) | 扫描与缓存 |
| [`classify/`](./ts-src/src/classify/) | 决策 |
| [`engine/`](./ts-src/src/engine/) | 编排 |
| [`execute/`](./ts-src/src/execute/) | 执行 |
| [`convert/`](./ts-src/src/convert/) | 格式转换 |
| [`metadata/`](./ts-src/src/metadata/) | SQLite |
| [`gui/`](./ts-src/src/gui/) | Web GUI |
| [`cli/`](./ts-src/src/cli/) | CLI |
| [`tools/`](./ts-src/src/tools/) | 诊断 |

设计参考：[typescript-rewrite-design.md](./docs/typescript-rewrite-design.md) · 归档：[docs/archive/](./docs/archive/)

## License

[MIT](./LICENSE.md)
