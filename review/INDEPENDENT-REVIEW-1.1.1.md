# Work Evidence 1.1.1 独立代码复审

复审对象：分支 `feat/work-evidence-1.1.1-efficiency`，`main...HEAD`
复审基线：`main` 7840220；被审提交 `bf88151`、`2dc125a`、`8b95114`
复审方式：逐文件阅读全量 diff、核对实验协议与原始单元、运行针对性测试与双宿主全量测试
复审人：主 Agent（非 CodeRabbit；本机无 `gh`、GitHub 会话未登录，无法生成 PR 审查）

## 结论

复审发现 **1 项发布阻断级文档完整性问题、1 项产品行为偏差、1 项实验协议泄漏**，均已在 `2dc125a`/`8b95114` 修复；另有 3 项低风险遗留，已登记不作为本次发布阻断。修复后的候选必须重新用真实任务复测，旧 C 证据不能直接代表新提交。

## 发现与处置

| 编号 | 严重度 | 发现 | 原始证据 | 处置 |
|---|---|---|---|---|
| R1 | 阻断 | `RELEASE-GATES-1.1.1.md`、`DEFECT-LEDGER-1.1.1.md` 整段复制 1.1.0 发布事实：候选 `2f398e0`、双宿主 619/619、效率 +23.19%、CodeRabbit 13 轮、tag `07e1488`、Release `439385235`、main `7a049c5`。其中 `07e1488` 实际是 `v1.1.0` 注释标签，`7a049c5` 是 1.1.0 合并提交；1.1.1 从未发布。 | `git ls-remote origin refs/tags/v1.1*`；GitHub Releases 页仅 1.1.0 为 Latest；`git log -- RELEASE-GATES-1.1.1.md` 仅 `bf88151` 一次提交 | `2dc125a` 重写：G1 记录真实 617/620，G4 第二宿主未测，G6 本分支 0 轮，发布状态改为“未发布”；删除伪造 tag/Release 段落 |
| R2 | 高 | `task-flow.mjs` 的激进模式默认提示包含“禁止访问网络、上游仓库或发布版”，属于实验隔离协议而非通用产品行为；普通用户需要联网查文档/装依赖时会被错误限制。 | `task-flow.mjs:43` 旧文本；`results/v7fa1-run01-c.protocol.json` 记录网络策略为实验层阻断 | `8b95114` 改为“以当前工作区、任务原文和已有工具结果为准；不得用上游现成实现替代；需要联网先确认用户授权”，并新增回归断言 `test/task-flow-execution.test.mjs` |
| R3 | 中 | 提示强制“实现后创建一个最小自删除复现测试并运行一次”，对既有测试已覆盖的一行修复造成过度写入和重复验证；#8 因此 22 请求 / $0.0129，对 B0 11 请求 / $0.0071，恶化 81.1%。 | `results/v7ba1-run08-c.json` 的 4 次 `write` 与 3 次 `npm test`；`FINAL-METRICS-1.1.1.json` #8 逐题改善 -0.811 | `8b95114` 改为“优先运行既有测试；未覆盖改动行为时才创建临时复现，运行一次后删除”；是否保留取决于新候选 24 题复测与评分 |
| R4 | 低 | `history-hygiene.mjs:88` 的 `TEST_COMMAND` 从 `(?:\.\\|\.\/)?` 改为 `(?:.\\|.\/)?`，把“字面点+分隔符”放宽为“任意单字符+分隔符”，`a/gradlew` 之类命令会被误归为 Gradle。 | `git diff main...HEAD -- history-hygiene.mjs` | 未修。触发需要命令以单字符+斜杠开头，实际误判面小；登记为 1.2.0 清理项，不阻断 |
| R5 | 低 | `state.toolCalls` 在 tool/call 时写入、tool/result 时删除；被中断且永不返回结果的调用会留在会话 Map，长会话内无上限。 | `history-hygiene.mjs:207` | 未修。每项仅存 name/arguments，量级小；登记为低风险，不阻断 |
| R6 | 中（已接受） | `toolOutputDigest` 对 ≥12,000 字符的工具输出在一步后隐藏中部，仅留头部/错误行/尾部；若模型需要中部某一匹配，必须 `work_recall` 取回。 | `history-hygiene.mjs:89-107`、`229-300`；`test/test-output-hygiene.test.mjs` 覆盖边界与定位 | 设计如此，规范事件不删；测试覆盖 12k 阈值、错误行、seq 与 recall 定位。保留 |
| R7 | 环境 | 桌面默认 profile 下 3 项 ACP 测试失败，错误为宿主 `@deepseek-ai/dsh-llm@0.2.2-rc.1` 不导出 `CallId`；改用实验保存的 `host-0.2.2-rc.1` + `profile-0.2.2-rc.1-isolated` 后 3/3 通过。 | `results/full-test-111.log` 与 `results/full-test-111-acp.log` 对比 | 非代码修复；验收命令固定隔离 profile，门禁记录真实环境 |
| R8 | 低（披露） | 24 题中 7 个 B0 使用“historical”标签（干净重建前样本）；C 全部使用 `a8f0bf1`。 | `experiments/1.1.1/manifest.json` 的 `label` 字段 | 报告已单列；历史 B0 仅用于未被网络污染的题，污染题全部重建。保留并在报告中说明 |

## 验证记录

- `npm run check`：146 个 JavaScript 文件通过。
- 双宿主全量：`0.2.2-rc.1` 620/620、`0.2.1-rc.4` 620/620，均 fail=0、skipped=0、exit 0（`results/full-test-111-acp.log`、`results/full-test-111-host-021.log`）。
- 针对性：`test/task-flow-execution.test.mjs` 30/30；`test/test-output-hygiene.test.mjs` 通过（含 TAP causes、通用输出回执、失败正文保护）。
- 打包：1.1.1 tarball 82 文件、426,167 字节、SHA-1 `d4ebd05f…`；独立安装加载通过。
- 未执行：CodeRabbit（无 PR/认证）。本文件不得被引用为 CodeRabbit 审查。

## 对发布门禁的影响

- R1 修复前，任何“1.1.1 已发布”的表述均不成立；修复后门禁表与远端事实一致。
- R2/R3 修改了 C 组行为，`a8f0bf1` 的 24 题指标不能直接作为 `8b95114` 的发布证据；必须重新跑 C 并按同一量表复评。
- R4/R5 保留为已知低风险，不阻断候选；若 1.2.0 触及相关代码，必须同时修复并补回归。
