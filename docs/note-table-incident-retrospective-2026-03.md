# 有道表格渲染事故复盘（2026-03）

> 事件：Markdown 表格上传后，桌面端出现“发生了一些错误”，并伴随显示异常  
> 范围：`md -> note json` 转换、云端回读验证、客户端验收流程、批量迁移流程  
> 目标：解释“为什么花了很久才定位根因”，并给出跨层改进  
> 用户命令见 [README 诊断](../README.md#常用诊断)；PR 证据栏见 [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md)

---

## 1. 结论先行

这次定位慢，不是单点失误，而是四条链路叠加：

1. **问题定义偏差**：一开始把问题当“内容差异”而不是“渲染契约差异”  
2. **样本基准错位**：早期“好版本/坏版本”对照对象选错，导致多轮比较在错误坐标系里打转  
3. **验收门禁缺失**：把“结构看起来正确”当成“客户端可用”，缺少桌面端打开验收这一层  
4. **工程约束后置**：新增 diagnose 能力后才遇到 lint 复杂度拦截，导致“功能已好但提交滞后”

最终真正根因是：**桌面端依赖原生表格节点与属性契约（`t/tr/tc` + `cw/rh/version`），而非仅能解析管道文本或不完整表格结构**。

---

## 2. 关键时间线（按对话阶段）

### 阶段 A：现象确认，但问题模型不对

- 现象：用户反馈“刷新以后还是一样”
- 动作：持续做 JSON/结构比较和回传验证
- 偏差：默认“只要结构接近就应可渲染”，没有把“客户端渲染契约”作为首要假设

### 阶段 B：拐点出现（样本纠正）

- 用户明确纠正：样本 B（`known_good`）可渲染，样本 A（`known_bad`）不可渲染
- 这一步是决定性转折：终于建立了正确 A/B 对照
- 随后对比才发现：好版本是 `native-table`，坏版本是 `pipe-text`

### 阶段 C：技术修复生效，但流程问题暴露

- 修复：重新输出原生表格结构，并补齐 `cw/rh/version`
- 结果：样本 A 桌面端确认恢复
- 新问题：用户指出“为什么不先自己验证”，暴露出流程上的验收短板

### 阶段 D：能力补齐 + 工程化收尾

- 新增并实战了 `check-note-tables / verify-note / migrate-note-tables / force-reupload`
- 批量迁移与回读成功
- 但提交阶段被 lint（`max-lines`/`complexity`）阻塞，后续再做结构拆分才完成第二个 commit

---

## 3. 为什么会慢：分层根因分析

## 3.1 认知层（问题建模）

- **把“格式等价”误当“渲染等价”**：JSON 语义近似不代表客户端渲染引擎可接受
- **没有先列“强假设清单”**：例如“桌面端是否要求特定表格属性”，导致排查顺序偏后

改进：

- 排障开场先写 3 条可证伪假设，并标注优先级  
- 涉及第三方客户端渲染时，默认优先检查“最小可渲染契约”

## 3.2 数据层（样本与对照）

- **初始 A/B 样本错位**：对照组一旦不准确，会把后续所有 diff 引向错误方向
- **缺少“样本确认检查点”**：没有在排查前固定“哪一份是金标准”

改进：

- 建立“样本确认三问”：
  - 哪个文件是已知可用？
  - 哪个文件是已知失败？
  - 两者是否都来自同一观察面（同客户端、同版本）？

## 3.3 验证层（测试与门禁）

- **过度依赖结构验证**：`check-note-tables` 早期能看结构，但不能替代最终渲染验收
- **验收分层不完整**：自动化层和人工层缺少明确边界与顺序

改进（固定为 3 层门禁）：

1. **结构门禁**：云端回读必须 `native-table`，且统计满足 `t>0, pipe=0`  
2. **同步门禁**：`sync --dry-run --push` 目标文件无 pending  
3. **渲染门禁**：桌面端 spot check（至少 2 个高风险样本）

## 3.4 工具链层（调试方式）

- **临时脚本先行、产品化命令后置**：前期探索快，但可复用性和一致性弱
- **已有 diagnose 能力未第一时间作为主路径**（后期才收敛）

改进：

- 同类问题优先扩展现有 `diagnose` 子命令，不新建一次性脚本  
- 临时脚本仅用于一次性探针，24 小时内必须“命令化”或删除

## 3.5 工程层（可提交性）

- **功能完成与可提交完成脱节**：诊断能力加完才暴露 lint 复杂度
- **大函数集中接线**：CLI 和 diagnose 聚合文件过长，触发 pre-commit 拦截

改进：

- 开发时就按 lint 阈值切分模块，避免“最后一公里返工”  
- 新命令接入遵循“一个命令一文件（或一组低耦合文件）”

## 3.6 协作层（沟通与预期）

- 用户多次给出关键纠偏信号（样本定义、验收要求）后，流程才完全切换
- 说明我们在“听到反馈 -> 改变排障策略”之间仍有延迟

改进：

- 收到用户纠偏后，立即输出“策略切换声明”（旧路径停止、改走新路径）  
- 任何“已修复”陈述前必须带验证证据类型（结构/同步/渲染）

---

## 4. 反事实：如果重来一次，最快路径是什么

理想最短路径：

1. 第一时间确认金标准：锁定“好/坏样本”  
2. 用 `check-note-tables` 对比 shape：5 分钟内识别 `native-table` vs `pipe-text`  
3. 直接验证 `t/tr/tc` 与 `cw/rh/version` 契约  
4. 修复后执行 `verify-note` + 桌面端 spot check  
5. 再进入批量迁移

可预期地，这会比“先做大量结构细节比对再回到契约层”更快。

---

## 5. 已落实的改进（本次对话内已完成）

- 修复转换器：输出原生表格结构，补齐 `cw/rh/version`，并做列数规范化  
- 新增/固化命令：`force-reupload`、`check-note-tables`、`verify-note`、`migrate-note-tables`  
- 批量迁移完成并回读通过，`sync --dry-run --push` 收敛到 0 变更  
- 代码结构重构：拆分 CLI 与 diagnose 模块，解决 lint 阻塞并完成后续提交

---

## 6. 后续改进计划（可执行）

## P0（立即执行）

- 在发布表格相关改动时，强制执行并记录：
  - `diagnose verify-note --target ...`
  - 桌面端 2 点位 spot check 结果
- 在 PR 描述中新增“渲染契约检查”小节（是否包含 `t/tr/tc/cw/rh/version`）

## P1（本周）

- 为 `md-to-note` 增加“契约测试用例”：
  - 缺 `cw/rh` 的表格对象应被判为不合格（或由构造器自动补齐）
  - 非规则行列输入时，输出必须稳定且不崩溃
- 增加一个“金样本回归集”（至少 3 个历史高风险文件）

## P2（本月）

- 建立一次“渲染回归自动化可行性”评估（桌面端自动化通道、替代方案、成本）  
- 将“样本确认三问 + 三层门禁”沉淀到项目规则文档

---

## 7. 复盘清单（下次同类问题直接套用）

- [ ] 我们是否先确认了好/坏样本，并写在任务上下文？  
- [ ] 当前排查假设是否围绕“渲染契约”而不是“结构相似度”？  
- [ ] 是否已跑 `check-note-tables` 并保存输出证据？  
- [ ] 是否已跑 `verify-note` 且 dry-run 无 pending？  
- [ ] 是否完成桌面端 spot check（至少 2 个样本）？  
- [ ] 新增命令是否在拆分结构下可通过 lint/pre-commit？

---

## 8. 一句话反思

这次最耗时的不是修代码，而是**先用错了问题模型**；一旦把“格式差异”切换为“渲染契约差异”，定位和修复都迅速收敛。

---

## 9. 用 Skill 改进 Debug（能力层）

这里的 Skill 指“可复用排障剧本”，不是单次聊天经验。  
目标是把“会调的人脑内流程”变成“任何人都能稳定执行的流程”。

## 9.1 这次事件里，Skill 应该长什么样

建议新增一个专用 skill（示例名）：`debug-note-table-render`

建议包含以下模块：

1. **触发条件**
   - 用户反馈桌面端“发生了一些错误”
   - 同一文件 web/云端可见但桌面端渲染异常
2. **输入要求**
   - 至少 1 个已知失败样本 + 1 个已知成功样本（同客户端观察面）
   - 目标文件路径清单
3. **固定排查顺序**
   - 样本确认 -> 结构对比 -> 契约校验 -> 修复 -> 验收
4. **输出要求**
   - 结构证据（shape/t-tr-tc/pipe）
   - 同步证据（dry-run）
   - 渲染证据（桌面 spot check）
5. **退出条件**
   - `verify-note` 通过且 spot check 通过

## 9.2 Skill 带来的改进点

- 把“第一步做什么”标准化，避免在错误假设上消耗时间  
- 每次都强制 A/B 样本，防止“对照组漂移”  
- 能把“我觉得修好了”变成“证据链完整才算修好”

## 9.3 Skill 模板（可直接落地）

```markdown
## Trigger
- Desktop render error reported for NOTE markdown table

## Required Inputs
- known_good_path
- known_bad_path
- target_paths[]

## Procedure
1) Confirm sample correctness with user (must pass)
2) Run diagnose check-note-tables on good/bad
3) Compare contract fields: t/tr/tc + cw/rh/version
4) Apply minimal fix
5) Run diagnose verify-note --target ...
6) Ask for desktop spot check on 2 high-risk files

## Deliverables
- Root cause
- Commands executed
- Evidence summary
- Risk + rollback
```

---

## 10. 用 .mdc 改进 Debug（规则层）

`.mdc` 适合放“行为约束”，不适合放大段操作手册。  
这次最关键的改进，是把“必须这样做”的部分写成规则，防止再次走弯路。

## 10.1 建议补充到 conditional .mdc 的规则

建议放入 `coding-patterns.mdc`（关键词已覆盖 debug/subagent/converter symmetry）：

- **样本先行规则**：任何对比分析前，先确认 good/bad 样本
- **契约优先规则**：第三方渲染问题优先校验最小契约，禁止先做大规模字节 diff
- **三层门禁规则**：结构门禁 + 同步门禁 + 渲染门禁
- **策略切换规则**：用户纠偏后，必须显式宣布“旧路径停止，新路径开始”

建议放入 `work-context.mdc` 的短条目（当期有效）：

- 本次高风险文件列表（spot check 白名单）
- 当前默认验收命令（`verify-note`）
- 当前已知陷阱（例如 `VERSION_CONFLICT (211)` 重试策略）

## 10.2 .mdc 能解决的“慢定位”问题

- 防止重复犯“验证顺序错误”
- 防止“已修复但无渲染证据”就宣布完成
- 防止临时经验随对话结束而丢失

---

## 11. 用 Subagent 改进 Debug（执行层）

Subagent 的价值不在“替你思考”，而在“并行分解证据链”。

## 11.1 适合并行化的三个子任务

1. **数据子任务（结构）**
   - 目标：定位 good/bad 的 JSON 结构差异
   - 输出：shape、字段缺失、统计差异
2. **流程子任务（同步）**
   - 目标：确认是否有 pending/冲突干扰结论
   - 输出：dry-run 结果、冲突清单、重试建议
3. **验收子任务（渲染）**
   - 目标：给出客户端侧可复现验证步骤
   - 输出：最小验收脚本、spot check 文件建议

## 11.2 Subagent 使用边界

- **可并行**：信息收集、日志比对、候选清单生成  
- **不并行**：会写同一目录/同一文件的改动任务（避免互相覆盖）  
- **先收敛再改动**：先让 subagent 各自产证据，再由主线程统一改代码

## 11.3 推荐分工模板

```text
Agent A: compare good/bad note shape and contract fields
Agent B: inspect sync status and pending kinds for targets
Agent C: generate desktop/web validation plan and risk checklist
Main: merge evidence -> pick fix -> implement once
```

---

## 12. 三者组合成一条“快路径”

可以把 Skill / .mdc / Subagent 看成三层：

- **Skill（方法）**：这类问题该怎么调  
- **.mdc（约束）**：哪些动作必须做、哪些不能跳  
- **Subagent（执行）**：怎么并行把证据快速拿全

组合后的标准流程：

1. Skill 触发 -> 自动要求 good/bad 样本  
2. .mdc 约束 -> 强制走契约优先 + 三层门禁  
3. Subagent 并行 -> 快速拿到结构/同步/验收三类证据  
4. 主线程一次修复 -> `verify-note` + spot check -> 收尾

---

## 13. 可量化的改进指标（建议纳入后续复盘）

- **T1 样本确认时延**：从用户报错到 good/bad 样本确认的分钟数  
- **T2 根因定位时延**：从样本确认到“可复现根因”的分钟数  
- **T3 修复验收时延**：从代码修复到三层门禁全部通过的分钟数  
- **返工次数**：修复后再次回滚/补丁次数  
- **无证据完成率**：没有结构+同步+渲染证据就宣称完成的比例（目标 0）

---

## 14. 公开仓库中的落地项

对外部贡献者，以这些为准（本地私有 `.cursor/` 规则/skill **不在本仓库**，clone 后看不到）：

1. ✅ PR 模板三栏证据：[`PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md)
2. ✅ 诊断命令：`check-note-tables` / `verify-note` / `migrate-note-tables` / `force-reupload`（见 [README](../README.md#常用诊断)）
3. ✅ 验收约定：结构证据 + dry-run 证据 + 桌面端抽检，缺一不可
4. 批量迁移时：并行收集证据可以，但由主线程统一提交改动
