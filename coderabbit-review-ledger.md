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
