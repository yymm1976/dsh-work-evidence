# CodeRabbit 审查台账

对象：`yymm1976/dsh-work-evidence` PR #7。数据来源：2026-11-08 直接读取 GitHub REST reviews 列表、review 正文、inline 评论与 GraphQL 审查线程。当前候选头部 `4978b31d017412214319bcd4ae8fa889492ed9fa`；本台账不替代最终同 SHA 复核。

## 正式 Review 全表

| Review ID | 审查 SHA / 范围 | 选中 / 跳过 | 发现与处置 | 计入结论 |
|---|---|---|---|---|
| `5808713807` | `3f01736`，`d12fce3..3f01736` | 39 选中 / 4 无可审变更 | 3 actionable：归档缓存先验版本（archive-store:146）、创建者取消后共享读取重试（archive-store:130）、trajectory 保留不确定写入（trajectory-audit:272-273）；3 nitpick：G4 记录宿主版本、padded deflate 测试、EOCD 歧义签名测试。actionable 由 `cc9dd30` 处理 | 有效审查 |
| `5808788160` | `cc9dd30`，`3f01736..cc9dd30` | 6 选中 / 2 相似跳过 | 2 actionable：ZIP64 entry 无 ZIP64 end record（archive-store:139-143）、joiner 可取消共享读取等待（archive-store:155）；由 `c1b20b5` 处理 | 有效审查 |
| `5808865604` | `c1b20b5`，`cc9dd30..c1b20b5` | 4 选中 / 2 相似跳过 | 无新增 actionable | 复核轮 |
| `5808893035` | `c57a7cc`，`c1b20b5..c57a7cc` | 1 选中 / 1 相似跳过 | 无新增 actionable | 复核轮 |
| `5810402652` | `0c9d76d`，`c57a7cc..0c9d76d` | 3 选中 | 1 actionable：completionNotice `planOnly` 正则误匹配“只按计划修改”等执行请求（completion-notice:22）；由 `eb1f616` 处理 | 有效审查 |
| `5812082035` | `b529100`，`0c9d76d..b529100` | 8 选中 | 无新增 actionable | 复核轮 |
| `5812663006` | `56f1824`，`b529100..56f1824` | 7 选中 | 1 actionable：MIGRATION 说明旧工作区保留 `completionNotice: true` 的检查与关闭方法（MIGRATION:14）；1 nitpick：opt-in 后测试关闭通知。由 `15abac4` 处理；bot 曾在 `56f1824` 上核验未确认（评论 `4502064405`），推送后线程解决 | 有效审查 |
| `5812700838` | `56f1824` 线程回复 | — | 线程解决回复，无新发现 | 不计独立覆盖 |
| `5812786085` | `15abac4`，`56f1824..15abac4` | 3 选中 / 1 相似跳过 | 无新增 actionable | 复核轮 |
| `5812860241` | `58de2a2`，`15abac4..58de2a2` | 1 选中 / 1 相似跳过 | `RELEASE-GATES-1.1.0.md` 被选中但因相似跳过，无实质审阅 | 不计覆盖；用户随后请求 full review（评论 `6708289055`） |
| `5812915220` | `58de2a2`，`d12fce3..58de2a2`（full review） | 45 选中 / 4 无可审变更 | 3 inline actionable：MIGRATION 测试运行位置（:26）、G6 提前通过（RELEASE-GATES:19）、公开本机路径 CWE-200（RELEASE-GATES:48-51）；1 outside-diff：`checkedJudgmentReviews` 未用 possibleChanges 语义且缺只读 Java 排除（trajectory-audit:356-363）；2 nitpick：`isReadOnlyJava` 助手抽取、`count>80` 阈值。由 `8743560` 处理 | 有效全量审查 |
| `5813072538` | `8743560`，`58de2a2..8743560` | 4 选中 | 1 actionable：FastEdit 只读分类应按真实 `operation`（trajectory-audit:24）；由 `4978b31` 修复，线程回复 `4502378862` / `4502380257` | 有效审查 |
| `5813132961` | `4978b31` 线程回复 | — | 线程解决回复，无新发现 | 不计独立覆盖 |
| `5813189085` | `4978b31`，`8743560..4978b31` | 5 选中 | 无新增 actionable；Docstring Coverage 警告仍在 | 有效审查 |

用户 Review：`5812696234`（`56f1824`，修复说明回复）、`5813131041`（`4978b31`，修复说明回复），不计入 CodeRabbit 覆盖。

## 线程与状态事实

- GraphQL 审查线程共 11 个，全部 `is_resolved=true`；inline 评论共 15 条，其中 11 条顶层、4 条回复。
- CodeRabbit 自动审查已暂停，最后 reviewed commit 为 `4978b31`（PR 置顶评论 `6698723007`）。新审查需用 `@coderabbitai review` 触发单次审查，或 `@coderabbitai resume` 恢复自动审查。
- Docstring Coverage `10.34%`（29 functions / 35 files，阈值 80%）是保留的非功能警告，不改写成通过或严重功能阻塞。
- 跳过文件、相似跳过和空正文回复不计入实质复核。最终候选在本台账覆盖之外继续修改时，G6 必须重新评估，并取得至少三轮覆盖最终代码的新有效审查。

## 独立复审

Mill 子代理（`opencode-go/deepseek-v4.1-flash`、`high`）核查原始 Review、候选源码和宿主日志，指出旧台账缺少 `5808713807` 等早期轮次、`hostresolved2` 不可计入、H1–H7 尚未逐项验证；意见已采纳并修准本文与失败分类。其 route 和 request ID 未由平台回传，不宣称该项传输证据完整。
