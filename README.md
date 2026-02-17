# youdaonote-sync

有道云笔记同步工具，支持双向同步、全量导出，并自动转换为 Markdown 格式。

## 功能

- 📥 全量导出笔记（支持增量更新）
- 🔄 双向同步（本地 ↔ 云端）
- 📝 自动转换 XML/JSON 格式为 Markdown
- 🖼️ 下载图片到本地或上传到图床
- 🖥️ GUI 图形界面
- ⌨️ CLI 命令行工具
- 🔍 搜索笔记功能

## 安装

### 方式一：pip 安装（推荐）

```bash
pip install youdaonote-sync[full]
```

### 方式二：从源码安装

```bash
git clone https://github.com/DeppWang/youdaonote-sync.git
cd youdaonote-sync
pip install -r requirements.txt
```

## 快速开始

### 1. 登录

```bash
# 自动登录（会弹出浏览器，扫码或输入账号登录）
python -m src login
```

> 首次运行前需安装 Playwright：`pip install playwright && playwright install chromium`

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

# 只上传（本地 → 云端）
python -m src sync --push

# 只下载（云端 → 本地）
python -m src sync --pull

# 预览模式（查看会执行哪些操作，但不实际执行）
python -m src sync --dry-run

# 指定同步目录
python -m src sync --dir E:/Projects/notes
```

同步规则：
- 只有本地有的文件 → 上传到云端
- 只有云端有的文件 → 下载到本地
- 两边都有且有修改 → 较新的版本覆盖较旧的
- 支持 Markdown 和普通笔记格式

### 4. 其他命令

```bash
# 启动图形界面
python -m src gui

# 列出目录结构
python -m src list

# 搜索笔记
python -m src search 关键词

# 搜索并下载
python -m src download 关键词
```

## 项目结构

```
├── src/                    # 核心包
│   ├── __main__.py         # CLI 入口（argparse + 命令分发）
│   ├── cli.py              # CLI 命令处理（pull/list/search/download/sync/gui）
│   ├── login.py            # 登录命令处理
│   ├── auth.py             # 浏览器认证（Playwright 登录、Cookie 刷新）
│   ├── api.py              # 有道云笔记 API 封装
│   ├── cookies.py          # Cookie 管理
│   ├── protocols.py        # Protocol 接口定义（ISP/DIP）
│   ├── common.py           # 公共工具函数
│   ├── log.py              # 日志配置
│   ├── watcher.py          # 自动同步守护进程（文件监听 + 轮询）
│   ├── gui/                # GUI 模块
│   │   ├── app.py          # GUI 界面
│   │   └── controller.py   # GUI 业务逻辑
│   ├── sync/               # 同步引擎
│   │   ├── engine.py       # 同步主流程
│   │   ├── scanner.py      # 文件扫描
│   │   ├── decision.py     # 同步决策
│   │   ├── moves.py        # 移动/重命名检测
│   │   ├── dedup.py        # 去重逻辑
│   │   ├── metadata.py     # 同步元数据管理
│   │   └── utils.py        # 同步工具函数（枚举、数据类、哈希）
│   ├── transfer/           # 传输模块
│   │   ├── download.py     # 下载引擎（单文件下载 + 类型检测）
│   │   ├── pull.py         # 全量拉取引擎（递归遍历云端目录）
│   │   ├── upload.py       # 上传引擎
│   │   ├── search.py       # 搜索引擎
│   │   ├── image.py        # 图片下载/链接迁移
│   │   └── image_upload.py # 图片上传到外部图床（SM.MS）
│   └── convert/            # 格式转换
│       ├── note_convert.py # 云端格式 → Markdown
│       └── md_to_note.py   # Markdown → 有道 JSON
├── config/                 # 配置文件
│   ├── cookies.json        # 登录凭证（自动生成）
│   ├── config.json         # 导出配置
│   └── sync_metadata.json  # 同步元数据（自动生成）
└── tools/                  # 辅助工具
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
  --dir, -d       导出目录（默认: ./youdaonote-sync）
  --ydnote-dir, -y  只导出有道云中的指定目录

# sync 参数
  --dir, -d       本地同步目录（默认从配置读取）
  --push          只上传（本地 → 云端）
  --pull          只下载（云端 → 本地）
  --dry-run       预览模式（不执行实际操作）

# search/download 参数
  keyword         搜索关键词
  --type, -t      搜索类型 (all/folder/file)
  --exact, -e     精确匹配
  --dir, -d       下载目录
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

# 或手动安装
pip install playwright && playwright install chromium
```

### GUI 启动失败

确保系统已安装 tkinter（Python 自带，通常无需额外安装）。

## 开发

```bash
# 安装开发依赖
pip install -e ".[dev]"

# 运行测试
pytest test/

# 格式化代码
black src/
```

## License

MIT
