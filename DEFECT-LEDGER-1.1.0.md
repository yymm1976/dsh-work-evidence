# 1.1.0 缺陷与旧债清零账本

对象：`feat/work-evidence-1.1.0`。最终候选以 Git 提交完整 SHA 为准，由同目录证据台账记录；本文件随候选提交更新。
记录时间：2026-11-08 起，最后更新 2026-11-09（Asia/Shanghai）。

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
| D15 | G3/G7 效率门禁（旧候选 C=`f89e668`）：对 B0 未观察到 ≥10% 改善，且留出方向反转 | 生产实验 | H13b 开发 Python `-31.3%`、Picomatch 每成功成本 `-31.8%`；v16 留出 Python `-47.3%`、Picomatch `-0.3%`，合计 `-24.2%`；H14/H3/H8 回退。**2026-11-09 复审更正：全部为 `reasoning_effort=high`，不符合本轮 `max` 路由契约，旧样本作废；v16 任务已多次复用，不能作为新留出。** v17 正在以 `max` 重跑开发集、新留出集与 Java；本行在 v17 结果和新 gate 记录完成前保持未关闭 | `OPTIMIZATION-REGISTER-1.1.0.md`、`holdout/results/`、`results/`、`PREREGISTRATION-v17*.json` | 未关闭（v18 max 复测完成，Python 留出反转，稳定发布阻断） |
| D16 | G6 CodeRabbit 最终候选三轮实质覆盖 | PR #7 | 六轮实质正文：`5819028970`（`05582be`，7 actionable）、`5819126598`（`0038b99`，1）、`5819153830`（`f89e668`，0 inline）、`5823492390`（`ffab4e0`，4+1 outside-diff）、`5825371763`（`ffcfb31`，1+1 outside-diff）、`5826437867`（`0ce60a6`，1 Major + 4 Minor + 1 nitpick）。最新一轮全部意见已修复；最终 SHA 仍需一次增量复审确认无新增可操作问题 | `coderabbit-review-ledger.md`、PR reviews、`evidence/coderabbit/review-5826437867*.json` | 未关闭（待最终 SHA 增量复审） |
| D17 | 正式实验 runner 把 `reasoningEffort` 硬编码为 `high`，与本轮要求的 `max` 契约不符 | 2026-11-09 复审与校准 | 新增 `run-unit-v17.mjs`，`--effort max` 默认、模型信息必须广告 max、逐请求校验；校准单元 `v17-cal-max-1` 记录 `identityValid=true`、逐请求 `effort=max`。所有旧 high 样本只作为历史校准，不进入本轮正式证据 | `run-unit-v17.mjs`、`results/cal-max-1.json`、`PREREGISTRATION-v17.json` | 关闭（工具修复；旧样本作废） |
| D18 | Java 评分器 `scorer.ps1` 为 UTF-8 无 BOM，PowerShell 5.1 把中文 JDK 路径解码为乱码，`JAVA_HOME` 被判无效 | 2026-11-09 直接复现 | 两个 Java scorer 加 UTF-8 BOM；开发正例评分 `pass=true`，负例跑出真实 10 个编译错误；原 stderr 与乱码路径保留 | `java/tasks/dev/scorer.ps1`、`java/tasks/heldout/scorer.ps1`、`java/evidence/logs/score-dev-20261108-175815.json` | 关闭 |
| D19 | Java 留出评分器从 Gradle 控制台输出解析 classpath，UTF-8 输出被错误解码，`HeldoutProbe` 找不到主源码包 | 2026-11-09 byte 级对比与复现 | `print-classpath.gradle` 改为把 classpath 以 UTF-8 写入 `build/dsh-main-runtime-classpath.txt`；scorer 用 `[IO.File]::ReadAllText(..., UTF8)` 读取；javac/java 期间关闭 `ErrorActionPreference=Stop`；正例 `HELDOUT_COOLDOWN_OK`、负例按预期失败 | `java/tasks/scripts/print-classpath.gradle`、`java/tasks/heldout/scorer.ps1`、`java/evidence/logs/score-heldout-20261108-181244.json`、`score-heldout-20261108-181315.json` | 关闭 |
| D20 | Java B0/C 失败被账本归因为“任务难度缺口”，实际评分器从未调用 Gradle | 2026-11-09 复审F2 | 旧 Java 结果全部标为装配无效（并区分 v9/v10/v11/v12 三类失败）；修正 `OPTIMIZATION-REGISTER`、`RELEASE-GATES`、`ACTIVE-PROGRESS` 与 `java/REPORT.md`，改为“未测量，待重跑” | `java/evidence/logs/score-dev-20261108-163733.log`、`results/java-v9..v12*.json`、复审报告 | 关闭（归因修正；Java 重测另行登记） |
| D21 | v16 留出任务在同一 base 上被多次复用，结果已进入候选决策，不能作为新的独立留出 | 2026-11-09 复审F3 | 新建未使用的 Python `~` 展开任务与 Picomatch `**` 邻接字面量任务，正负例校准通过；v17b 预注册记录任务/评分器哈希；v16 仅作 max 路线重测，不声称新留出 | `holdout/new-20261109/PREREGISTRATION-v17b.json`、`holdout/new-20261109/scorers/` | 关闭（新任务已建立；B0/C 待跑） |
| D22 | Python tilde 留出任务 C 比 B0 贵 28.9%，3/3 对全部反转；旧 prompt-a 版本也 +19.8% | v18 max 实验 | 任务/评分器/route 均已冻结，提示词两次修正后仍同向；按现行“开发集与留出集均不反向”门禁阻断稳定发布。未通过合并 dev+holdout 或换标签吸收。需要新的短任务机制或新独立留出任务，不能降门槛 | `results/v18-python-tilde-*.json`、`archive/v18-tilde-prompt-a/results`、`PREREGISTRATION-v18-addendum-tilde-b.json` | 未关闭（发布阻断） |
| D23 | Picomatch dev 的 +26.1% 来自 H13 零触发子集（3 个 C 运行 testOutputViews=0），占加权收益 50.5% | v18 max 实验 | 剔除该子集后 H13 实际触发收益仅 +6.38%，低于 10%；该子集差异归因于输入/缓存结构与模型轮次，不能登记为机制收益。需要短任务真实机制 | `results/v18-picomatch-dev-c-*.json`、`results/v18-final-metrics.json` | 未关闭（G7 阻断） |
| D24 | Java 跨模块留出评分器 `:48` 在 Gradle 首次编译后缺 `Continue`，任何 stderr 都会终止，C 首轮未评分 | v18 max 实验 / 复审F3 | 已在 `java/tasks/heldout/scorer.ps1` 首次 Gradle 调用前加 `Continue`，正例/负例校准通过；C 重测 67 请求/134 工具、16.8 分钟，真实评分仍失败（探针编译失败、3 处存在性检查缺失）；B0 也失败且有评分。该任务当前为任务难度/模型能力缺口，非插件回归 | `java/tasks/heldout/scorer.ps1`、`java/evidence/logs/score-heldout-20261108-205814.log`、`results/v18-java-heldout-c-2.json` | 关闭（工具修复；任务未解决） |
| D25 | `history-hygiene.mjs` 把插件自身 diagnostic 中的「原始输出」误判为用户请求完整输出，关闭该步全部测试回执投影，导致完整 pytest 输出重入上下文与缓存失效 | 修复前 `c0dd3f2` 的 5 个 C 样本原始轨迹；`final4-run-c-2` step 19 单请求 59466 input token / 0.0095 USD（占 51%）。修复后 `0ce60a6` 的 v23 复验：Python dev 每成功 `0.018927117` 对 B0 `0.033628047`（+43.72%），Python run 组 `0.010426122` 对 B0 `0.013237287`（+21.24%） | H15：新增 `fullOutputRequest(event)`，仅真实用户消息与已回答的 `user-question-reply` 可设置该标志；canonical 输出与 `work_recall` 恢复不变。定向回归 2 项 / 12 断言（`node-test-rc4-0ce60a6.log` 中 `ok 179`、`ok 180`），真实轨迹重放旧 2 / 新 0 次误禁用 | `history-hygiene.mjs`、`test/history-full-output-request.test.mjs`、`results/v23-*.json`、`results/INDEX-pairs.json` | 关闭（同 SHA 真实复验转正；最终 SHA 重跑另行登记） |

| D26 | 实验装配：java-simple-open 任务的首条 allowedCommands 正则解码后为 `^.\gradlew.bat ...` 其中反斜杠加 g 在 u 标志下抛 Invalid escape，所有 Java 单元 agent 侧 100% 命令被拒，从未真正执行构建 | 独立复审与 runner --guard-check 权威复现 | 新建 java-simple-open-v24 任务，正则解码后为 `^\.\\gradlew\.bat ...`，--guard-check 返回 allowed:true； 旧任务标记 retired 并保留原始证据；新增 tmp/validate-task-contracts.mjs 前置校验 57 条模式 0 无效 | tasks/java-simple-open-v24.json、results/task-contract-preflight.json、旧样本 results/open-java-*.json | 关闭（装配修复；旧样本标为装配无效，不混算） |
| D27 | Java simple 评分器复用 heldout 探针，测「灵脉等级/调整时间重载保留」但该要求从未写进 prompt，C-2 失败属规格传递缺陷而非实现能力 | 独立复审逐行核对 `scorer.ps1`、`HeldoutProbe.java` 与 prompt | v24 prompt 明确写入「灵脉等级与调整时间在保存/加载后按原值保留」；B0 在修复后的 v24 任务上通过（42 请求、scorer pass、delivered true），证明装配有效 | `tasks/java-simple-open-v24.json`、`java/tasks/simple/scorer.ps1`、`results/v24-java-b0-1.json` | 关闭（装配修复；C 配对另行登记） |
| D28 | `ffcfb31` 因「Node 回执后成本不稳、重复验证」整体关闭 `node --test` 回执，导致 Picomatch 半区 `testOutputViews=0`、收益无法归因。当时的判断发生在 H15 缺陷仍存在时 | 独立复审 + 真实轨迹：48685 字符 TAP 输出在两臂均完整入上下文 | H16：只为带完整 `# tests/# pass/# fail` 摘要的 TAP 输出生成有界回执，保留失败名、计数、前三条错误原因、尾部与 `work_recall` locator；无摘要、截断、spill、无 seq 一律不投影。最终候选上 Picomatch 两组转为正向（dev +23.60%、留出 +27.23%） | `history-hygiene.mjs`、`test/test-output-hygiene.test.mjs`、`results/v30-final-metrics.json` | 关闭（真实 B0/C 复验转正） |
| D29 | `session/disposed` 不等 `agent/disposed` 异步清理完成即删除 runtime state，effect-observer 会重建无 telemetry 目录的状态，丢失最后一批 pending 决策 | CodeRabbit `5826437867` Major | 新增 `disposal-coordinator.mjs`：session 处置等待 agent 清理完成再释放；无 agent 的 session 立即释放；清理抛错仍释放。3 项确定性回归 | `disposal-coordinator.mjs`、`test/disposal-coordinator.test.mjs`、`index.mjs` | 关闭（确定性回归） |
| D30 | 实验装配：`scorers/python-dev.py` 用顶层 `assert`，实现缺陷变成未捕获异常，`stdout` 为空且样本不可评分 | 复审 P2 + `v23-pydev-c-3`/`final-pydev-b0-3` 同点崩溃 | 改为逐项命名失败、永不崩溃；新增 `bare-key` 检查（缺键即失败）。两臂在新评分器上重跑（v26/v29） | `scorers/python-dev.py`、`results/v26-*.json`、`results/v29-*.json` | 关闭 |
| D31 | TAP 测试回执缺少错误原因，模型为查明失败原因反复重跑完整套件（实测 50 请求、`testOutputViews=47`、同组成本增加 45.6%） | 最终候选首轮复验 `v25-capneg-c-2` | 回执新增 `causes`（≤3 条），并改为顺序无关解析 TAP 诊断块（Node 22.19 先输出 `error: |-` 后输出 `name`） | `history-hygiene.mjs`、`test/test-output-hygiene.test.mjs` | 关闭 |
| D32 | Java dev 旧 B0 样本与新 C 的 `baseHash` 不同（`9adf6126` vs `80a30596`），base 快照已变，不可混样 | 同 SHA 复核 | 旧 B0 标为不可比并从配对剔除；改用当前 base 的 B0（`v28-javadev-b0-5/6`、`v29-javadev-b0-1`） | `results/v28-javadev-b0-*.json`、`results/v29-javadev-b0-1.json` | 关闭 |

## 说明

- 本账本只记录有直接证据的项；未证实的猜测不列为已修复。
- 环境类问题（D01）没有通过放宽源码断言来“修复”；验收命令固定为隔离 profile。
- 被否决的 H8 代码已回退，但其原始结果和登记保留，不能从账本或登记中删除。
- D15/D22/D23 记录的是旧候选（C=`f89e668`/v18）的失败，不阻断最终候选；最终候选的 G3/G7 由同 SHA 验收台账记录。D16（CodeRabbit 覆盖最终 SHA）仍是发布前必须确认项。
- 旧候选不得用其 RC 冒充稳定版；最终候选只有在同 SHA 的 G0–G9（含 G6 覆盖最终 SHA）全部通过后才可发布。
