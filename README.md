# youdaonote-sync

有道云笔记同步工具，支持双向同步、全量导出，并自动转换为 Markdown 格式。

TypeScript 实现，基于 Node.js 运行。

## 功能

### 核心同步

- 全量导出笔记（支持增量更新）
- 双向同步（本地 <-> 云端）
- 自动同步模式（本地文件监听 + 定时轮询云端）
- 自动转换 XML/JSON/HTML 格式为 Markdown，支持 Markdown 反向转换为有道 JSON 格式上传
- 下载图片到本地或上传到图床（SM.MS）
- 智能去重（自动清理云端重复文件）
- Git 自动提交（同步后自动 commit）
- 选择性同步（include/exclude 规则，只同步指定目录）

### 同步引擎

- Content Hash 决策：mtime 变化但内容未变时自动跳过，避免无效同步
- 三方 Hash 精炼：云端内容 hash 对比，CONFLICT 降级为单向操作
- 删除追踪：区分"用户删除"和"从未同步"，防止误重建
- 移动/重命名检测：file_id、content hash、文件名三级匹配
- Merkle Tree 目录级快速变更检测
- Bloom Filter 快速集合查询
- 三路合并（diff3 算法，自动合并非重叠修改）
- 扫描缓存（SQLite 缓存 + listRecent 增量更新，无变化时 API 调用减少 99%）
- 操作日志（类 Git reflog，每次同步记录可审计可回溯）
- 元数据垃圾回收 + 完整性校验
- 应用层重试 + 指数退避（网络错误自动恢复）
- 进程锁（PID lock file 防止多实例同时运行）

### 客户端

- Web GUI 图形界面（浏览器访问）
- CLI 命令行工具
- 诊断工具（path 查询、decision 分析、dry-run 汇总）

## 安装

```bash
git clone https://github.com/DeppWang/youdaonote-sync.git
cd youdaonote-sync/ts-src
npm install
```

安装 Playwright 浏览器（用于自动登录，可选）：

```bash
npm install playwright
npx playwright install chromium
```

## 快速开始

### 1. 登录

```bash
# 自动登录（会弹出浏览器，扫码或输入账号登录）
npx youdaonote-sync login
```

### 2. 配置

编辑 `config/config.json`：

```json
{
    "local_dir": "/path/to/your/notes",
    "ydnote_dir": "",
    "smms_secret_token": "",
    "is_relative_path": true
}
```

### 3. 双向同步

```bash
# 双向同步（云端和本地互相更新）
npx youdaonote-sync sync

# 预览模式（查看会执行哪些操作，但不实际执行）
npx youdaonote-sync sync --dry-run

# 只上传（本地 -> 云端）
npx youdaonote-sync sync --push

# 只下载（云端 -> 本地）
npx youdaonote-sync sync --pull

# 自动 git commit
npx youdaonote-sync sync --git

# 指定同步目录
npx youdaonote-sync sync --dir /path/to/notes

# 不自动去重
npx youdaonote-sync sync --no-dedup
```

### 4. 自动同步模式

```bash
# 监听文件变化 + 定时轮询云端（默认 300 秒）
npx youdaonote-sync watch

# 自定义轮询间隔（60 秒）
npx youdaonote-sync watch --interval 60

# 自动 git commit
npx youdaonote-sync watch --git
```

### 5. Web GUI

```bash
# 启动 Web 图形界面（默认端口 3456）
npx youdaonote-sync gui

# 自定义端口
npx youdaonote-sync gui --port 8080
```

然后在浏览器中打开 `http://localhost:3456`，可以浏览、搜索和下载笔记。

### 6. 诊断工具

```bash
# 查看 dry-run 汇总统计
npx youdaonote-sync diagnose summary

# 查找指定路径在云端扫描结果中的匹配情况
npx youdaonote-sync diagnose path --target "目录/文件名.md"

# 查看指定文件的分类决策详情
npx youdaonote-sync diagnose decision --target "目录/文件名.md"

# 重置扫描缓存（强制下次全量扫描）
npx youdaonote-sync diagnose reset-cache

# 强制指定文件在下次 sync 时重传（只改 metadata，不直接上传）
npx youdaonote-sync diagnose force-reupload --target "目录/文件名.md"

# 检查云端 NOTE 表格结构（native-table / pipe-text）
npx youdaonote-sync diagnose check-note-tables --target "目录/文件名.md"

# 一键验收门禁：目标文件必须是 native-table，且 push dry-run 无待上传
npx youdaonote-sync diagnose verify-note --target "目录/文件名.md"

# 批量扫描并标记仍是 pipe-text 的 NOTE 表格文件（支持 dry-run）
npx youdaonote-sync diagnose migrate-note-tables --dry-run --filter "内在世界/日记/2026/"
npx youdaonote-sync diagnose migrate-note-tables --filter "内在世界/日记/2026/" --limit 20
```

### 7. 表格修复发布门禁（必跑）

当改动 `md-to-note` / `json-to-md` 表格逻辑后，发布前至少跑：

```bash
# 1) 转换器测试
cd ts-src
npm test -- src/convert/md-to-note.test.ts src/convert/json-to-md.test.ts

# 2) 构建
npm run build

# 3) 目标文件结构验收（native-table + push dry-run clean）
npx youdaonote-sync diagnose verify-note --target "目录/文件名.md"
```

### 8. 调试规范资产（Skill / Rules / PR 模板）

为避免再次出现“结构正确但客户端渲染失败”的慢定位问题，仓库已提供三类资产：

- Debug skill：`.cursor/skills/debug-note-table-render/SKILL.md`
  - 规范了样本先行、契约优先、三层门禁的排障流程
- Rules：
  - `.cursor/rules/coding-patterns.mdc`（渲染契约 debug 规则）
  - `.cursor/rules/work-context.mdc`（当前默认验收入口与反模式提醒）
- PR 模板：`.github/PULL_REQUEST_TEMPLATE.md`
  - 强制记录 `Shape Evidence` / `Dry-run Evidence` / `Desktop Spot Check`

## 项目结构

```
├── ts-src/                    # TypeScript 源码
│   ├── src/
│   │   ├── types/             # branded types、FileState、CloudFile 等
│   │   ├── api/               # 有道云笔记 API
│   │   │   ├── client.ts      # API 封装（fetch）
│   │   │   ├── auth.ts        # 浏览器认证（Playwright 登录）
│   │   │   ├── cookies.ts     # Cookie 管理
│   │   │   └── ...
│   │   ├── scan/              # 文件扫描（云端 BFS + 本地 readdir + 缓存）
│   │   ├── classify/          # 同步分类（状态机决策）
│   │   │   ├── classify.ts    # 文件状态分类
│   │   │   ├── calibrate.ts   # 元数据校准
│   │   │   ├── moves.ts       # 移动/重命名检测
│   │   │   └── ...
│   │   ├── engine/            # 同步引擎（编排层）
│   │   │   ├── engine.ts      # SyncEngine: scan → classify → execute
│   │   │   ├── execute.ts     # 桥接 engine 和 executor
│   │   │   ├── watcher.ts     # 自动同步守护进程（fs.watch + 轮询）
│   │   │   └── helpers*.ts    # dry-run 报告生成
│   │   ├── execute/           # 同步执行（单文件操作）
│   │   │   ├── types.ts       # SyncStats, ExecuteContext
│   │   │   ├── executor.ts    # executeAll(): 并发调度
│   │   │   ├── download.ts    # 下载 + 格式转换
│   │   │   ├── upload.ts      # 上传
│   │   │   ├── move-handler.ts # 移动/重命名
│   │   │   ├── conflict.ts    # 冲突处理 + diff3 合并
│   │   │   └── images*.ts     # 图片下载/URL 改写/图床上传
│   │   ├── metadata/          # 同步元数据（SQLite）
│   │   ├── convert/           # 格式转换（XML/JSON/HTML → Markdown）
│   │   ├── algo/              # 算法（XXH3 hash、Bloom Filter、Merkle Tree、diff3）
│   │   ├── dedup/             # 去重逻辑
│   │   ├── browse/            # 搜索、单次拉取
│   │   ├── gui/               # Web GUI（HTTP 服务器 + 单页应用）
│   │   ├── cli/               # commander CLI 入口
│   │   ├── tools/             # 诊断工具（diagnose、profile）
│   │   ├── perf/              # 性能分析器
│   │   └── util/              # 工具函数（路径、并发、锁、git、前置条件）
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts
├── config/                    # 配置文件
│   ├── cookies.json           # 登录凭证（自动生成）
│   ├── config.json            # 同步配置
│   └── sync_metadata.db       # 同步元数据（SQLite，自动生成）
└── docs/                      # 设计文档与审查报告
```

## 同步规则

- 只有本地有的文件 -> 上传到云端（如果元数据显示曾同步过则视为云端删除，跳过上传）
- 只有云端有的文件 -> 下载到本地（如果元数据显示曾同步过则视为本地删除，跳过下载）
- 两边都有且 mtime 变了 -> 先比较 content hash，内容相同则跳过；内容不同时较新覆盖较旧
- 双方都改了不同内容 -> 三方 hash 精炼，如果只有一端实际改了则单向同步，否则按 mtime 决定
- 支持 Markdown 和多种笔记格式（XML/JSON/HTML -> Markdown 自动转换）
- 自动检测并清理云端重复文件
- 支持文件移动/重命名检测（避免删除+重建）

## 依赖

| 依赖 | 用途 |
|------|------|
| better-sqlite3 | SQLite 同步元数据存储 |
| commander | CLI 命令行框架 |
| fast-xml-parser | XML 格式解析 |
| xxhash-wasm / xxh3-ts | 高速哈希（内容 hash、Bloom Filter） |
| playwright (可选) | 自动登录（浏览器扫码） |

## 开发

```bash
cd ts-src

# 运行测试
npm test

# 类型检查
npm run typecheck

# 代码格式化
npm run format

# Lint
npm run lint
```

## License

MIT
