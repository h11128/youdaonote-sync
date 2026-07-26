---
name: 提 Issue 请使用这个模版
about: Issue 格式
title: ''
labels: ''
assignees: ''

---

请先在 [Issues](https://github.com/h11128/youdaonote-sync/issues) 搜索是否已有相同问题。

Issue 请尽量包含：

- **操作系统**：如 Windows 11、macOS 14、Ubuntu 22.04
- **Node.js 版本**：`node -v`（需要 18+）
- **是否已构建**：在 `ts-src/` 下执行过 `npm install` 与 `npm run build`
- **配置目录（SOT）**：`npx youdaonote-sync config path`（默认 Windows `%APPDATA%\youdaonote-sync\`，macOS/Linux `~/.config/youdaonote-sync/`；可用 `YOUDAONOTE_CONFIG_DIR` 覆盖）。不要使用仓库内 `config/`。
- **复现步骤**：命令、预期结果、实际结果（可附 `sync --dry-run` 与 `config doctor` 摘要；**不要**粘贴 `cookies.json` 或 token）
- **格式问题**：若下载后格式异常，请附可公开的样例片段或分享链接（打码隐私内容）

安装与用法见 [README](https://github.com/h11128/youdaonote-sync#readme)。
