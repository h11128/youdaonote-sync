# youdaonote-sync

有道云笔记同步工具，支持双向同步、全量导出，并自动转换为 Markdown 格式。

## 功能

### 核心同步

- 📥 全量导出笔记（支持增量更新）
- 🔄 双向同步（本地 ↔ 云端）
- 👀 自动同步模式（持续监听文件变化 + 定时轮询云端）
- 📝 自动转换 XML/JSON 格式为 Markdown，支持 Markdown 反向转换为有道 JSON 格式上传
- 🖼️ 下载图片到本地或上传到图床（SM.MS）
- 🔍 智能去重（自动清理云端重复文件）
- 📦 Git 自动提交（同步后自动 commit）
- 📁 选择性同步（include/exclude 规则，只同步指定目录）

### 同步引擎

- 🔒 Content Hash 决策：mtime 变化但内容未变时自动跳过，避免无效同步
- 🔀 三方 Hash 精炼：云端内容 hash 对比，CONFLICT 降级为单向操作
- 🏷️ 删除追踪：区分"用户删除"和"从未同步"，防止误重建
- 🔄 移动/重命名检测：file_id、content hash、文件名三级匹配
- 🌳 Merkle Tree 目录级快速变更检测
- 🌸 Bloom Filter 快速集合查询
- 📊 三路合并（diff3 算法，自动合并非重叠修改）
- 🗄️ 扫描缓存（SQLite 缓存 + listRecent 增量更新，无变化时 API 调用减少 99%）
- 📋 操作日志（类 Git reflog，每次同步记录可审计可回溯）
- 🧹 元数据垃圾回收 + 完整性校验
- 🔁 应用层重试 + 指数退避（网络错误自动恢复）
- 🔐 进程锁（PID lock file 防止多实例同时运行）

### 客户端

- 🖥️ GUI 图形界面
- ⌨️ CLI 命令行工具
- 🔎 搜索笔记功能

## 安装

### 方式一：pip 安装（推荐）

```bash
pip install youdaonote-sync[full]
```

### 方式二：从源码安装

```bash
git clone https://github.com/DeppWang/youdaonote-sync.git
cd youdaonote-sync
pip install -e ".[full]"
```

安装 Playwright 浏览器（用于自动登录）：

```bash
playwright install chromium
```

## 快速开始

### 1. 登录

```bash
# 自动登录（会弹出浏览器，扫码或输入账号登录）
python -m src login
```

### 2. 导出笔记

```bash
# 全量导出
python -m src pull

# 导出到指定目录
python -m src pull --dir ./backup

# 只导出指定目录
python -m src pull --ydnote-dir 工作笔记
```

### 3. 双向同步

```bash
# 双向同步（云端和本地互相更新）
python -m src sync

# 自动同步模式（持续监听文件变化 + 定时轮询云端）
python -m src sync --watch

# 只上传（本地 → 云端）
python -m src sync --push

# 只下载（云端 → 本地）
python -m src sync --pull

# 预览模式（查看会执行哪些操作，但不实际执行）
python -m src sync --dry-run

# 指定同步目录
python -m src sync --dir E:/Projects/notes

# 不自动 git commit
python -m src sync --no-git

# 不自动去重
python -m src sync --no-dedup
```

同步规则：
- 只有本地有的文件 → 上传到云端（如果元数据显示曾同步过则视为云端删除，跳过上传）
- 只有云端有的文件 → 下载到本地（如果元数据显示曾同步过则视为本地删除，跳过下载）
- 两边都有且 mtime 变了 → 先比较 content hash，内容相同则跳过；内容不同时较新覆盖较旧
- 双方都改了不同内容 → 三方 hash 精炼，如果只有一端实际改了则单向同步，否则按 mtime 决定
- 支持 Markdown 和普通笔记格式（.note XML/JSON → Markdown 自动转换）
- 自动检测并清理云端重复文件
- 支持文件移动/重命名检测（避免删除+重建）

### 4. 其他命令

```bash
# 启动图形界面
python -m src gui

# 列出目录结构
python -m src list

# 列出指定目录（深度 3 层）
python -m src list 工作笔记 --depth 3

# 搜索笔记
python -m src search 关键词

# 搜索并下载
python -m src download 关键词
```

## 项目结构

```
├── src/                      # 核心包（35 个 .py 文件）
│   ├── __main__.py           # CLI 入口（argparse + 命令分发）
│   ├── cli.py                # CLI 命令处理（pull/list/search/download/sync/gui）
│   ├── login.py              # 登录命令处理
│   ├── auth.py               # 浏览器认证（Playwright 登录、Cookie 刷新）
│   ├── api.py                # 有道云笔记 API 封装（httpx）
│   ├── cookies.py            # Cookie 管理
│   ├── protocols.py          # Protocol 接口定义（9 个角色接口，ISP/DIP）
│   ├── common.py             # 公共常量、NewType（FileId/DirId）、工具函数
│   ├── log.py                # 日志配置
│   ├── watcher.py            # 自动同步守护进程（文件监听 + 轮询）
│   ├── gui/                  # GUI 模块
│   │   ├── app.py            # GUI 界面（tkinter）
│   │   └── controller.py     # GUI 业务逻辑
│   ├── sync/                 # 同步引擎
│   │   ├── engine.py         # 同步主流程 + 扫描缓存 + 进程锁
│   │   ├── scanner.py        # 文件扫描（本地多线程 + 云端异步 + 选择性过滤）
│   │   ├── decision.py       # 同步决策（校准 + SyncItem 构建）
│   │   ├── moves.py          # 移动/重命名检测（file_id + hash + 文件名三级）
│   │   ├── dedup.py          # 云端去重（内容 hash 分组 + 评分保留）
│   │   ├── metadata.py       # 同步元数据（SQLite：files/directories/sync_log/sync_state）
│   │   ├── merkle.py         # Merkle Tree 目录级快速变更检测
│   │   ├── bloom.py          # Bloom Filter 概率集合查询
│   │   ├── rolling_hash.py   # 滚动哈希（内容相似度检测）
│   │   ├── merge.py          # 三路合并（diff3 算法）
│   │   ├── git_helper.py     # Git 自动提交
│   │   ├── desktop_data.py   # 有道桌面客户端数据解析（冷启动加速）
│   │   └── utils.py          # 同步工具函数（枚举、数据类、哈希、重试）
│   ├── transfer/             # 传输模块
│   │   ├── download.py       # 下载引擎（单文件下载 + 类型检测 + 原子写入）
│   │   ├── pull.py           # 全量拉取引擎（递归遍历云端目录）
│   │   ├── upload.py         # 上传引擎（Markdown + 二进制 + 目录创建）
│   │   ├── search.py         # 搜索引擎
│   │   ├── image.py          # 图片下载 + Markdown URL 改写
│   │   └── image_upload.py   # 图片上传到外部图床（SM.MS）
│   └── convert/              # 格式转换
│       ├── note_convert.py   # 云端格式 → Markdown（统一入口 + 纯函数）
│       ├── xml_convert.py    # XML 格式解析
│       ├── json_convert.py   # JSON 格式解析
│       └── md_to_note.py     # Markdown → 有道 JSON（上传 domain=0 笔记）
├── config/                   # 配置文件
│   ├── cookies.json          # 登录凭证（自动生成）
│   ├── config.json           # 导出配置
│   └── sync_metadata.db      # 同步元数据（SQLite，自动生成）
├── docs/                     # 设计文档与审查报告
├── tools/                    # 辅助工具
│   ├── cli/                  # 命令行辅助（Cookie 提取、API 抓包）
│   └── debug/                # 调试诊断（元数据检查、dry-run 报告）
└── test/                     # 测试用例（7 个测试文件 + fixtures）
```

## 配置文件

编辑 `config/config.json`：

```json
{
    "local_dir": "",           // 本地目录（留空则当前目录）
    "ydnote_dir": "",          // 只导出指定目录（留空则全部）
    "smms_secret_token": "",   // SM.MS 图床 token（可选）
    "is_relative_path": true   // 图片使用相对路径
}
```

## 命令行参数

```bash
python -m src --help

# 可用命令
  login      登录有道云笔记（使用浏览器）
  gui        启动图形界面
  pull       全量导出所有笔记
  sync       双向同步笔记
  list       列出目录内容
  search     搜索文件或文件夹
  download   搜索并下载

# pull 参数
  --dir, -d         导出目录（默认: ./youdaonote-sync）
  --ydnote-dir, -y  只导出有道云中的指定目录

# sync 参数
  --dir, -d         本地同步目录（默认从配置读取）
  --push            只上传（本地 → 云端）
  --pull            只下载（云端 → 本地）
  --dry-run         预览模式（不执行实际操作）
  --watch, -w       自动同步模式（监听文件变化 + 定时轮询）
  --interval, -i    云端轮询间隔秒数（默认 60）
  --no-git          不自动 git commit
  --no-dedup        不自动去重

# list 参数
  path              目录路径（可选）
  --depth, -n       显示深度（默认: 2）

# search/download 参数
  keyword           搜索关键词
  --type, -t        搜索类型 (all/folder/file)
  --exact, -e       精确匹配
  --dir, -d         下载目录
```

## 常见问题

### Cookies 过期

重新运行登录命令：

```bash
python -m src login
```

### 缺少依赖

```bash
# 安装完整依赖
pip install youdaonote-sync[full]

# 安装 Playwright 浏览器
playwright install chromium
```

### GUI 启动失败

确保系统已安装 tkinter（Python 自带，通常无需额外安装）。

### 同步冲突

当本地和云端都有修改时，默认使用较新版本覆盖较旧版本。使用 `--dry-run` 预览同步操作：

```bash
python -m src sync --dry-run
```

### 自动同步模式

使用 `--watch` 模式可以持续监听文件变化并自动同步：

```bash
# 默认 60 秒轮询一次云端
python -m src sync --watch

# 自定义轮询间隔（120 秒）
python -m src sync --watch --interval 120
```

## 开发

```bash
# 安装开发依赖
pip install -e ".[dev]"

# 运行测试
pytest test/

# 格式化代码
black src/

# 类型检查
pyright src/
```

## 架构概览

同步引擎的核心流程：

```
sync()
  ├── _acquire_lock()           # PID 进程锁
  ├── _get_cloud_files()        # 扫描缓存 → listRecent 增量 → 全量 HTTP fallback
  ├── scan_local()              # 多线程本地扫描（+ 选择性过滤）
  ├── calibrate_metadata()      # 校准元数据基线（content hash）
  ├── reconcile_moves()         # 三级移动检测（file_id → hash → 文件名）
  ├── build_item() × N          # 构建 SyncItem（decide_action 决策）
  ├── _refine_conflicts()       # 三方 hash 精炼 CONFLICT
  ├── _execute_all()            # 分离线程池（下载 10 + 上传 5）
  │   ├── _do_download()        # 原子写入 + 格式转换 + 重试
  │   └── _do_upload()          # Markdown/二进制上传 + 重试
  ├── auto_dedup()              # 内容去重（复用 hash_cache）
  ├── auto_git()                # Git 自动提交
  └── _release_lock()
```

## 依赖说明

| 依赖 | 用途 | 安装方式 |
|------|------|----------|
| httpx | HTTP 客户端（线程安全，支持异步） | 核心依赖 |
| markdownify | HTML → Markdown 转换 | 核心依赖 |
| Brotli | Brotli 解压（部分 API 响应） | 核心依赖 |
| xxhash | 高速哈希（内容 hash、Bloom Filter、Merkle Tree） | 核心依赖 |
| playwright | 自动登录（浏览器扫码） | `[login]` 或 `[full]` |
| watchdog | 文件监听（watch 模式） | `[watch]` 或 `[full]` |
| win32-setctime | Windows 文件时间设置 | `[windows]` 或 `[full]` |
| browser-cookie3 | 从浏览器提取 Cookie | `[browser]` 或 `[full]` |

## License

MIT
