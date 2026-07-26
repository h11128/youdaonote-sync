# youdaonote-sync

有道云笔记本地同步工具：把云端笔记同步成 Markdown，支持双向同步、定时监听和 Web 浏览。

- 语言：TypeScript / Node.js
- 仓库：https://github.com/h11128/youdaonote-sync

## 它能做什么

| 能力 | 说明 |
|------|------|
| 双向同步 | 本地 ↔ 云端互相更新 |
| 单向同步 | `--push` 只上传，`--pull` 只下载 |
| 自动同步 | `watch`：监听本地改动 + 定时轮询云端 |
| 格式转换 | 有道 XML/JSON/HTML ↔ Markdown |
| 图片处理 | 下载到本地，或上传到 SM.MS 图床 |
| 去重 / 移动检测 | 清理云端重复文件，识别重命名与移动 |
| Git 提交 | 同步后可选自动 `git commit` |
| Web GUI | 浏览器浏览、搜索、下载笔记 |
| 诊断 | `diagnose` 查看决策、缓存、表格结构等 |

## 环境要求

- Node.js **18+**（推荐 20+）
- 可访问有道云笔记账号
- 自动登录需要 Playwright（可选，也可手动准备 Cookie）

## 安装

```bash
git clone https://github.com/h11128/youdaonote-sync.git
cd youdaonote-sync/ts-src
npm install
npm run build
```

可选：安装 Playwright，用于浏览器扫码登录：

```bash
npm install playwright
npx playwright install chromium
```

之后所有命令都在 `ts-src/` 目录下执行（或通过 `npx youdaonote-sync …`）。

## 配置

配置文件默认放在系统目录（不在仓库里，也不会进 git）：

| 系统 | 路径 |
|------|------|
| Windows | `%APPDATA%\youdaonote-sync\` |
| macOS / Linux | `~/.config/youdaonote-sync/` |

也可用环境变量覆盖：

```bash
export YOUDAONOTE_CONFIG_DIR=/path/to/your-config
```

创建 `config.json`（把 `local_dir` 改成你的笔记目录）：

```json
{
  "local_dir": "/path/to/your/notes",
  "ydnote_dir": "",
  "smms_secret_token": "",
  "is_relative_path": true,
  "sync_exclude": [
    "**/*.log",
    "**/__pycache__/**"
  ]
}
```

| 字段 | 含义 |
|------|------|
| `local_dir` | 本地笔记根目录（必填） |
| `ydnote_dir` | 只同步云端某个子目录；空字符串表示全部 |
| `smms_secret_token` | SM.MS 图床 token；不填则图片下载到本地 |
| `is_relative_path` | 图片链接是否写成相对路径 |
| `sync_include` | 可选，只同步匹配的路径（glob 数组） |
| `sync_exclude` | 可选，排除匹配的路径（glob 数组） |

同目录还会自动生成：

- `cookies.json` — 登录凭证
- `sync_metadata.db` — 同步元数据（SQLite）

若你以前把配置放在仓库的 `config/`，可运行一次：

```bash
npx youdaonote-sync migrate
```

## 快速开始

### 1. 登录

```bash
npx youdaonote-sync login
```

会打开浏览器，扫码或账号登录即可。

### 2. 先预览，再正式同步

```bash
# 只看会做什么，不改任何文件
npx youdaonote-sync sync --dry-run

# 双向同步
npx youdaonote-sync sync

# 只上传 / 只下载
npx youdaonote-sync sync --push
npx youdaonote-sync sync --pull

# 同步后自动 git commit
npx youdaonote-sync sync --git

# 临时覆盖本地目录
npx youdaonote-sync sync --dir /path/to/notes
```

### 3. 自动同步（守护进程）

```bash
# 默认每 300 秒轮询一次云端，并监听本地改动
npx youdaonote-sync watch

# 自定义间隔（秒）
npx youdaonote-sync watch --interval 60 --git
```

### 4. Web GUI

```bash
npx youdaonote-sync gui
# 浏览器打开 http://localhost:3456

npx youdaonote-sync gui --port 8080
```

### 5. 浏览 / 导出（不依赖同步元数据）

```bash
npx youdaonote-sync list --path "工作"
npx youdaonote-sync search --name "周报"
npx youdaonote-sync download --cloud-path "工作/周报.md" --out ./tmp
npx youdaonote-sync pull --dir ./youdaonote-export
```

## 同步规则（简版）

- 只有本地有 → 上传；若元数据显示曾经同步过，则视为云端已删，默认不重建
- 只有云端有 → 下载；若元数据显示曾经同步过，则视为本地已删，默认不重建
- 两边都有但内容相同（即使 mtime 变了）→ 跳过
- 两边内容不同 → 尽量单向同步；无法判定时按较新一侧覆盖
- 支持移动/重命名检测，减少「删旧建新」
- 可用 `sync_include` / `sync_exclude` 做选择性同步
- 需要把删除同步到另一端时，加 `--propagate-deletes`（会配合本地回收站逻辑）

## 常用诊断

出问题先 dry-run，再用 diagnose：

```bash
npx youdaonote-sync sync --dry-run
npx youdaonote-sync diagnose summary
npx youdaonote-sync diagnose path --target "目录/文件名.md"
npx youdaonote-sync diagnose decision --target "目录/文件名.md"
npx youdaonote-sync diagnose reset-cache
npx youdaonote-sync diagnose force-reupload --target "目录/文件名.md"
```

NOTE 表格相关（桌面端渲染异常时）：

```bash
npx youdaonote-sync diagnose check-note-tables --target "目录/文件名.md"
npx youdaonote-sync diagnose verify-note --target "目录/文件名.md"
npx youdaonote-sync diagnose compare-cloud-local --target "目录/文件名.md"
```

更多命令见：`npx youdaonote-sync diagnose --help`

## Windows 定时同步（可选）

可用系统任务计划程序每天跑一次同步。仓库不附带已注册任务；请自行创建，例如调用：

```bat
cd /d E:\Projects\youdaonote-sync\ts-src
npx youdaonote-sync sync --git
```

在 Git Bash 里操作 `schtasks` 时，建议加 `MSYS_NO_PATHCONV=1`，避免路径被错误转换。

## 开发

```bash
cd ts-src

npm test          # 测试
npm run typecheck # 类型检查
npm run lint      # Lint
npm run format    # 格式化
npm run build     # 编译到 dist/
```

源码在 `ts-src/src/`：

```
ts-src/src/
├── api/        # 有道 API、登录、Cookie
├── scan/       # 云端 / 本地扫描与缓存
├── classify/   # 同步决策（上传/下载/冲突/移动）
├── engine/     # 编排：scan → classify → execute
├── execute/    # 单文件执行（下载、上传、冲突合并）
├── convert/    # 格式转换
├── metadata/   # SQLite 元数据
├── gui/        # Web GUI
├── cli/        # 命令行入口
└── tools/      # 诊断工具
```

设计说明与审查记录见 `docs/`。

## License

MIT
