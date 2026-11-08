# 1.1.0 缺陷与旧债清零账本

对象：`feat/work-evidence-1.1.0`。最终候选以包含本文件的提交为准（本文件在 `399c33b` 之后随文档提交更新）。
记录时间：2026-11-08（Asia/Shanghai）。

状态含义：`关闭` = 有复现代码/测试或真实运行证据；`环境关闭` = 已证明为隔离装配问题并固定了验收命令；`否决` = 机制经配对实验否决且代码已回退；`未关闭` = 仍是发布阻断。

| ID | 缺陷/旧债 | 来源 | 处置 | 证据 | 状态 |
|---|---|---|---|---|---|
| D01 | rc4 全量中 3 个 ACP 测试报 `dsh-llm` 缺 `CallId` | `after-readiness-fix` 日志 | 根因是 `DSH_PROFILE` 指向含旧 0.1.5-rc.2 嵌套 `@deepseek-ai/dsh` 的桌面 profile；改用隔离 profile 后 3 项全过 | `verification/node-test-rc4-d7fb48c.log`、`node-test-rc1-d7fb48c.log`、本目录 `ACCEPTANCE-d7fb48c.md` | 环境关闭 |
| D02 | `deferPressureCompaction` readiness 未检查 `hasRequestBudgetView` | 功能终审 | `0af6e62` 增加依赖原因；`d7fb48c` 把仅缺预算视图时标为 `waiting` | `test/feature-control.test.mjs` | 关闭 |
| D03 | `compressionControl` 缺 agent 级状态释放 | 功能终审 / CodeRabbit `5817997957` | `0af6e62` 监听 `session/disposed`；本轮增加 `agent/disposed` 清理同一 session 状态 | `test/compression-control.test.mjs`（session 与 agent 两条回归） | 关闭 |
| D04 | `ledgerReceipt` 在 `evidenceViews` 关闭时仍可被显式 `responseView:"reference-if-visible"` 触发 | CodeRabbit #4506189044 | `15d83da` 在 receipt 入口先判 `evidenceViews`；新增显式视图回归 | `test/default-path-consistency.test.mjs` | 关闭 |
| D05 | README 把 `memberParsing` 写成通用语法解析 | CodeRabbit #4506189041 | `15d83da` 限定 Java 语法范围，其他语言明确为文本窗口 | `README.md:534` | 关闭 |
| D06 | Release Gates 链接的 CodeRabbit 台账不在发布包内 | CodeRabbit #4506189046 | `15d83da` 把台账、功能矩阵和优化登记加入 `files`；`644019b` 再加入缺陷账本 | `package.json`、`verification/pack-b69b468.json`（81 项含全部文档） | 关闭 |
| D07 | `DSH_APP` 在两处测试中使用不同的空值/空白处理 | CodeRabbit nitpick | `15d83da` 统一使用 `test/helpers/paths.mjs` 的 trim 值 | `test/package-install.test.mjs`、`test/host-compatibility.test.mjs` | 关闭 |
| D08 | 仓库根 `local-dsh-work-evidence-1.1.0.tgz` 含已删除旧文档 | 功能终审 | 删除旧工件；当前工件由 `npm pack` 重新生成 | `artifacts/local-dsh-work-evidence-1.1.0.tgz` 哈希 `891466...13abf` | 关闭 |
| D09 | `workflow012` route 缺 `name` | 功能终审 P1 | `0af6e62` 增加 `@local/dsh-work-evidence/flash1017-preset` | `cordis.patch.yml`、`test/release-syntax.test.mjs` | 关闭 |
| D10 | locale 仍声明“三种手动模式” | 功能终审 P1 | `0af6e62` 改为“按思考档位生效的任务模式” | `locale/en.json`、`locale/zh.json` | 关闭 |
| D11 | `install-local.mjs` 一次性无入口脚本 | 功能终审 | `0af6e62` 删除 | `package.json files`、打包清单 | 关闭 |
| D12 | 旧 `HISTORY.md`、`1.1.0-SCOPE-FREEZE.md`、重复失败分类/审查台账 | 文档审计 | `7c36edf` 清理 10 个文件 `+67/-1339` | `git show 7c36edf` | 关闭 |
| D13 | H8 旧推理请求视图省略被证实为负优化 | 本会话 H8 开发实验 | Python 三对均值 B0 `235,985` vs C `225,087`（改善 `4.6%`，未达 10%），两对 C 请求更多；代码回退，测试撤回 | `results/dev-python-v6-h8-*.json`、`OPTIMIZATION-REGISTER-1.1.0.md` H8 判定、`5355c64`/`399c33b` | 否决 |
| D14 | 全量套件在回退 H8 后仍保留其测试，rc4 `602/1` | 本会话回归 | `399c33b` 恢复 pre-H8 测试文件 | `verification/node-test-rc4-399c33b.log` | 关闭 |
| D15 | G3/G7 效率门禁：C_final 对 B0 未观察到 ≥10% 改善 | 生产实验 | H1–H8 均未形成可复现净收益；H3/H8 为负，其他未证明 | `ACTIVE-PROGRESS.md`、`OPTIMIZATION-REGISTER-1.1.0.md`、`results/` | 未关闭（发布阻断） |
| D16 | G6 CodeRabbit 最终候选三轮实质覆盖 | PR #7 | 三轮实质正文：`5817854228`（`d7fb48c`）、`5817950552`（`5355c64`）、`5817997957`（`5355c64..b69b468`）；第三轮在 PR head `b69b468` 上，并发现 D03 的 `agent/disposed` 缺口。修复后 SHA 变化，需再做一次覆盖最终代码的增量 Review | `coderabbit-review-ledger.md`、PR reviews | 未关闭（最终 SHA 覆盖待确认） |

## 说明

- 本账本只记录有直接证据的项；未证实的猜测不列为已修复。
- 环境类问题（D01）没有通过放宽源码断言来“修复”；验收命令固定为隔离 profile。
- 被否决的 H8 代码已回退，但其原始结果和登记保留，不能从账本或登记中删除。
- D15/D16 未关闭时不得合并 PR、打 tag 或创建 Release。
