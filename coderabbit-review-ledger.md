# CodeRabbit 审查台账

对象：`yymm1976/dsh-work-evidence` PR #7。

采集：2026-11-08 直接读取 GitHub REST reviews、review comments、GraphQL review threads 和 checks。原始 JSON 保存在本次交付的 `evidence` 目录，不写入发布包。

## 当前状态

- PR #7 为 Open、非 Draft，目标 `main`；远端 head 为 `4978b31d017412214319bcd4ae8fa889492ed9fa`。
- 远端没有针对本地后续候选的 Review、comment 或 check。运行时代码审查基线止于 `238f125`，其后还有未审查的文档清理；最终审查范围以 `4978b31..最终 SHA` 的实际 diff 为准，审查台账不写会自引用的本地 HEAD。
- REST Review 共 16 条记录：CodeRabbit 14 条（12 轮正式审查和 2 条线程回复）、用户 2 条。CodeRabbit 有 10 轮实质覆盖；2 轮相似文件跳过和 2 条回复不计独立覆盖。
- 共记录 19 条意见：13 条 actionable（11 条 inline、2 条 outside-diff）和 6 条 nitpick。13 条 actionable 已处理；5 条 nitpick 已处理，`count>80` 的 1 条保留为非阻塞。
- 11 个 GraphQL 审查线程全部 resolved，其中 10 个 outdated。REST inline 评论 15 条：11 条顶层、4 条回复。
- CodeRabbit 自动审查已暂停，最后 reviewed commit 为 `4978b31`。当前候选的 G6 覆盖为 `0/3`，不能继承远端审查结论。

## 正式 Review

| Review | reviewed SHA | 覆盖与结论 |
|---|---|---|
| `5808713807` | `3f01736` | 有效；3 actionable 归档缓存/共享读取/轨迹不确定写入，3 nitpick |
| `5808788160` | `cc9dd30` | 有效；2 actionable ZIP64 与 joiner 取消 |
| `5808865604` | `c1b20b5` | 有效复核；无新增 actionable |
| `5808893035` | `c57a7cc` | 唯一文件相似跳过；不计覆盖 |
| `5810402652` | `0c9d76d` | 有效；1 actionable `planOnly` 正则 |
| `5812082035` | `b529100` | 有效复核；无新增 actionable |
| `5812663006` | `56f1824` | 有效；1 actionable 迁移说明，1 nitpick |
| `5812696234` | `56f1824` | 用户回复；不计 CodeRabbit 覆盖 |
| `5812700838` | `56f1824` | 空正文线程回复；不计独立覆盖 |
| `5812786085` | `15abac4` | 有效；G1/G4/G9 不得沿用早先结果 |
| `5812860241` | `58de2a2` | 唯一门禁文件相似跳过；不计覆盖 |
| `5812915220` | `58de2a2` | 有效 full review；3 inline、1 outside-diff、2 nitpick |
| `5813072538` | `8743560` | 有效；FastEdit 只读分类按真实 operation |
| `5813131041` | `4978b31` | 用户回复；不计 CodeRabbit 覆盖 |
| `5813132961` | `4978b31` | 空正文线程回复；不计独立覆盖 |
| `5813189085` | `4978b31` | 有效增量复核；无新增 actionable |

## 处置

| 文件 | 意见 | 处理 |
|---|---|---|
| `archive-store.mjs` | 共享读取取消、读取版本与缓存时机、ZIP64 entry 哨兵、joiner 取消 | `cc9dd30`、`c1b20b5`；增加并发、取消、版本和 ZIP64 回归 |
| `trajectory-audit.mjs` | 不确定写入保留、possibleChanges 失效、只读 Java 分类、抽取 helper | `cc9dd30`、`8743560`、`4978b31`；线程已解决 |
| `completion-notice.mjs` | `planOnly` 不匹配“只按计划修改”等执行请求 | `eb1f616`；加入确认门禁和回归 |
| `MIGRATION-1.1.0.md` | 旧工作区 `completionNotice:true` 的检查与关闭；测试位置 | `15abac4`、`8743560`；迁移说明已修 |
| `RELEASE-GATES-1.1.0.md` | G1/G4/G9 和 G6 不得预写通过；公开本机路径 CWE-200 | `8743560`、`4978b31`；改为同 SHA 待确认并使用占位符 |
| `host-features.test.mjs` | 通知测试应先开启再关闭 | `15abac4`；同会话回归 |
| `release-syntax.test.mjs` | `count>80` 依赖仓库文件数 | 未处理；非阻塞，发布前重新评估 |

## 当前候选要求

`4978b31` 之后包含运行流程、工具 schema、打包、宿主测试、发布文档和本轮文档清理。它们没有远端 Review。最终 SHA 至少需要：

1. 推送 PR head 后触发一次覆盖 `4978b31..最终 SHA` 的 full review。
2. 处理当前代码仍成立的意见，并做增量复审。
3. 至少取得三轮正文实质覆盖最终代码的有效 Review，记录 review ID、SHA、选中文件和处理结果。
4. 全部线程 resolved 后，才可把 G6 记为通过。

Docstring Coverage `10.34%`（29/35 文件，阈值 80%）是保留警告，不当作功能正确性证明。

## 2026-11-08 最终候选复审

- PR head `4978b31` → `d7fb48c` 后提交 `@coderabbitai review`（comment `6721352082`）。CodeRabbit 于 `12:22:20Z` 产出 Review `5817854228`，正文有 3 条 actionable 和 1 条 nitpick：
  - `README.md:534`：`memberParsing` 只能声明 Java 语法范围，其他语言是文本窗口。
  - `README.md:536` / `observation-ledger.mjs`：`evidenceViews` 关闭时，显式 `responseView:"reference-if-visible"` 仍能触发 receipt。
  - `RELEASE-GATES-1.1.0.md:27`：门禁链接的 `coderabbit-review-ledger.md` 不在发布包内。
  - nitpick：`DSH_APP` 在 `package-install.test.mjs` 与 `host-compatibility.test.mjs` 中的空白处理不一致。
- 处置提交 `15d83da`：receipt 入口在 `ledgerReceipt` 之后先判 `evidenceViews`；新增显式视图回归；README 限定 Java；`package.json files` 加入 CodeRabbit 台账、功能矩阵和优化登记；两处测试统一使用 `test/helpers/paths.mjs` 的 trim 值。`npm run check` 通过，相关 19 项定向测试通过。
- 处置后 head 为 `399c33b`（`5355c64` 回退 H8，`399c33b` 撤回遗留 H8 测试）。`5355c64` 与 `399c33b` 尚无 CodeRabbit 正文；最终 SHA 仍需覆盖 `5817854228` 之后差异的增量 Review。
- 第二轮 Review `5817950552`（`12:50:27Z`，reviewed `5355c64`）正文有 3 条 actionable：
  - `test/host-history.test.mjs:57,60`：回退 H8 后遗留的旧推理断言和 `reasoningMessages` 状态字段不成立。该文件已在 `399c33b` 恢复为 pre-H8 版本，两项随之消失。
  - `test/default-path-consistency.test.mjs:124`：显式视图测试只验证“没有 receipt”，未验证两次读取都拿到完整正文。已在本轮修复中加入 `the quick brown fox` 两处正文断言。
- 第三轮 Review `5817997957`（`13:06:07Z`，reviewed `5355c64..b69b468`）正文有 2 条 actionable：
  - `DEFECT-LEDGER-1.1.0.md:12`：`compressionControl` 只监听 `session/disposed`，缺 `agent/disposed` 的同 session 状态清理。已在本轮加入 `agent/disposed` 清理并新增 agent 级回归；`test/compression-control.test.mjs` 5/5 通过。
  - `DEFECT-LEDGER-1.1.0.md:25`：D16 需区分“较早候选的 Review”与“最终 SHA 覆盖”。已改写为三轮实际记录，并明确最终代码增量复审仍待做。
- 覆盖计数：已有 3 轮实质正文（`5817854228`、`5817950552`、`5817997957`）；第三轮覆盖到 PR head `b69b468`。但因本轮 D03 修复会产生新 SHA，G6 的最终代码覆盖仍需一次增量 Review，当前不记为通过。
- 待办：推送当前修复与新 SHA，请求覆盖最终代码的增量 Review；处理新增意见并确认全部线程 resolved。不得用空正文回复或相似文件跳过充数。

## 2026-11-08 第四轮

- Review `5818275842`（`14:34:27Z`，reviewed `6acc52d`）正文有 2 条 actionable：
  - `OPTIMIZATION-REGISTER-1.1.0.md:27`：v7 轨迹证据引用的文件不在仓库/发布包。已新增脱敏公开摘要 `TRAJECTORY-ANALYSIS-1.1.0.md`，并改引用；原始结果 JSON 留在交付证据目录，不进入发布包，不含凭据。
  - `RELEASE-GATES-1.1.0.md:22`：G9 把 `b69b468` 写成通过，但候选随后已改动；同 SHA 要求不满足。已把 G0/G1/G2/G4/G5/G8/G9 改回“待最终 SHA”，`b69b468` 仅作历史证据。
- 覆盖计数：四轮实质正文（`5817854228`、`5817950552`、`5817997957`、`5818275842`）；最终 SHA 增量 Review 仍待做。G6 不记为通过。

## 2026-11-09 第五轮（最终候选 05582be）

- Review `5819028970`（`2026-11-08T18:11:16Z`，reviewed `05582bec1eda62897e88937771f323eea1a7a042`），正文 11,662 字符；7 条 actionable + 1 nitpick；覆盖最终候选全部变更文件。
- Major：`RELEASE-GATES-1.1.0.md` G3/G7 不应标通过，D15 需回退。已改为 pending，D15 重新打开。
- `archive-store.mjs`：第二次外部取消绕过 `ARCHIVE_CHANGED`，line 193 不可达。已去掉 `attempt===0` 限制，并新增“第二次外部取消返回 ARCHIVE_CHANGED”回归。
- `history-hygiene.mjs`：命令记录达到 64 后静默停止追踪。已改为淘汰最旧项；新增行为不改变 H13 的 8k/4k 触发逻辑。
- `experiment-cli.mjs`、`test/helpers/paths.mjs`、`test/package-install.test.mjs`：相对路径与空 `npm_execpath` 未解析。已统一 `path.resolve`/空值保护。
- `ROLLBACK-1.1.0.md`：回退时只替换插件目录会保留 1.1.0 归一化配置。已要求恢复升级前 config 备份并处理退役设置。
- Nitpick（history-hygiene 正结果正则过宽）保留为非阻塞；receipt 始终带尾部与 recall 指针，不丢失正文。
- 处置后的新 SHA 尚需一次增量 Review；全部线程 resolved 后 G6 才能通过。
