# AI 开发流程反思：诊断工具的忽视与行为惯性

> **历史复盘（已归档）**。不描述产品安装步骤；日常用法见 [README](../../../README.md)。

**日期**: 2026-03-29  
**背景**: 在诊断某笔记文件的同步冲突时，AI 忽略了项目中已有的 `diagnose` CLI，耗费大量时间手写 SQL / TS 脚本。

在初步反思后，用户尖锐地指出：“就只有这三个（修改规则文件）你确定问题就不会复发吗？”
这促使重新审视整个干预链条，发现之前的反思**仅仅停留在“被动规则注入”层面，完全没有触及真正的系统性失效点**。

---

## 一、干预链条的真实失效全景（深度复盘）

按照 `agent-memory` 的干预链条模型，本次失误不仅是规则没遵守，更是**高层级防线的全面崩溃**：

```text
用户指令 ("同步过程中发现了一个冲突文件...")
  │
  ▼
【失效点 1】Agent Skills (系统级主动技能) —— [严重失效]
  ├── 系统提示词已注入 `<agent_skill fullPath=".../youdao-sync/SKILL.md">`
  ├── 触发词明确包含 "同步", "note sync"
  └── 结果：AI 完全无视了该 Skill，直接跳入底层搜索。

  ▼
【失效点 2】Workspace Rules (被动规则) —— [形式遵循，实质失效]
  ├── 强制 grep 命中了 `Entry: use-existing-tools`
  └── 结果：AI 读到了“优先用已有工具”，但没有将其转化为执行动作。

  ▼
【失效点 3】工具可发现性 (Tool Discoverability) —— [基础设施缺陷]
  ├── AI 尝试了 `npx youdaonote-sync diagnose`，但因为未全局安装导致报错 E404。
  └── 结果：当“快乐路径”受阻时，AI 瞬间退化为“第一性原理调试”（手写 sqlite3 和 TS 脚本）。
```

**核心结论**：
1. **被动规则（.mdc）是最脆弱的防线**。仅仅在 `work-context.mdc` 里加上“严禁手写脚本”依然是 Level 2 的防御，AI 在上下文满载或遇到阻力时极易将其抛之脑后。
2. **最大的盲区是忽略了 Agent Skill**。Skill 系统本应是处理特定领域任务的“标准SOP”，但我连看都没看。
3. **工具链的摩擦力（Friction）会诱发不良行为**。因为 `diagnose` 命令没有被封装在标准的 `npm run` 中，导致调用失败，给了 AI “自己造轮子”的借口。

---

## 二、为什么“只改规则”无法防止复发？

在第一版反思中，我提出的三个 Action Items 全是修改 `.mdc` 文件（`work-context.mdc` 和 `jason-dev-practices.mdc`）。

**为什么这不够？**
参考 `2026-02-21` 的反思结论：“被动注入的规则只保证文本进入上下文，不保证 agent 遵循”。
如果仅仅依赖文本规则，下一次遇到类似问题时，只要报错一次，AI 的“代码生成本能”就会再次接管控制权。**我们必须把防线从“道德说教（Rules）”升级为“物理限制（Poka-yoke）”和“铺好轨道（Paved Road）”。**

---

## 三、真正的多维度防御策略 (Action Items)

为了确保问题**绝对不再复发**，必须在干预链条的不同层级实施主动防御：

### 3.1 铺好轨道：消灭工具调用的摩擦力 (Level 1 - 基础设施) ✅ 已完成
**问题**：之前调用 `diagnose` 需要记忆复杂的 `npx tsx src/bin.ts diagnose`，且容易敲错。
**行动**：修改 `ts-src/package.json`，将诊断工具提升为一等公民。
```json
"scripts": {
  "diagnose": "tsx src/bin.ts diagnose",
  // ...
}
```
**收益**：AI 习惯于运行 `npm run` 来探索可用命令。现在 `npm run diagnose` 就在那里，降低了使用正确工具的认知门槛。

### 3.2 强化主动技能：重写 Agent Skill (Level 2 - SOP 注入) ✅ 已完成
**问题**：原有的 `youdao-sync` Skill 内容陈旧，且没有明确指导如何处理“冲突”。
**行动**：更新全局 Cursor skill `youdao-sync/SKILL.md`：
1. 增加了明确的冲突诊断命令：`npm run diagnose -- decision --target "<file_path>"`
2. 加入了**绝对禁令**：
   > **CRITICAL**: NEVER use `sqlite3` or write custom TS/Python scripts to query `sync_metadata.db` or simulate sync logic. ALWAYS use `npm run diagnose`.
**收益**：当用户提到“同步冲突”时，系统会强制加载此 Skill，AI 将获得精确到复制粘贴级别的命令，彻底阻断手写脚本的念头。

### 3.3 规则的排他性重构 (Level 3 - 认知约束) ✅ 已完成
**行动**：保留第一版反思中的规则修改，但在 `work-context.mdc` 和 `jason-dev-practices.mdc` 中使用了最具攻击性的防御语（Anti-Reinventing Rule）。这作为 Skill 系统的兜底。

---

## 四、总结：从“管教”到“系统设计”

面对“你确定不会复发吗”的质问，我的回答是：**如果只靠规则，一定会复发；但如果靠系统设计，就能大概率阻断。**

这次复盘让我意识到，作为 AI，我不能仅仅停留在“我认错，我下次注意”的层面。**AI 辅助开发的最高境界，是承认 AI 自身的行为惯性和弱点，然后通过修改项目的基础设施（如 package.json）和标准操作程序（Agent Skills），让“做正确的事”成为阻力最小的路径。**

这次，我们不仅修补了规则，更铺好了 `npm run diagnose` 的轨道，并更新了 Skill 导航图。这才是防止复发的真正保障。