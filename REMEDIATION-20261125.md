# 系统性缺陷整改记录（2026-11-25）

对象：`feat/v04-windows-bash`。整改起点 `9e2a3d4`，按《系统性缺陷整改执行规格》完成七阶段修改。本文只记录当前成立的行为、验证方式和真实限制。

## 验证结果

| 项 | 结果 |
|---|---|
| 语法检查 | `npm run check`，190 个 JavaScript 文件通过 |
| 全量单测 | `npm test`，1065 项，1064 通过，0 失败，1 项按宿主能力跳过 |
| 跳过原因 | 当前宿主三包均为 `0.2.2-rc.1`，条件写入后端可用；只描述“后端缺失”的用例按设计跳过 |
| 打包安装 | `test/package-install.test.mjs` 通过；离线安装不拉宿主 peer，安装副本可加载 |
| 声明文件加载 | `test/host-package-load.test.mjs` 通过；94 个声明文件，44 个功能项，无阻塞项 |
| 宿主兼容 | `test/host-compatibility.test.mjs` 通过；声明与宿主运行时一致 |
| 性能数据 | `evidence/profile-default-path-20261125.json`；30 轮，本地处理分段 |

## 反向验证

对关键门禁临时撤销防护后运行对应测试，确认测试失败，再恢复实现：

| 门禁 | 临时撤销 | 结果 |
|---|---|---|
| 明确写入授权 | `sourceOnlyMaintenanceTask()` 不再检查 `intent.writeAuthorized` | `task detection...` 失败：仅凭六个症状就进入有界补丁 |
| 请求账本完整性 | 恢复 `pendingRequestRows.slice(-32)` | `more than 32 failed request rows...` 失败：早期行被丢弃 |
| 已应用计数 | 让拒绝写入也进入 `applied` | `a concurrent native change...` 失败：状态从 `failed` 变为 `partial` |

三项恢复后均通过。反向验证只证明对应测试能区分旧实现，不证明真实任务质量。

## 一、权限与写入

### 任务意图

`task-intent.mjs` 新增 `classifyTaskIntent()` 与 `hasWriteAuthorization()`。`sourceOnlyMaintenanceTask()` 只接受同时满足“只读否定未成立”和“存在明确写入授权”的请求。项目规模、症状数量只决定机制适用性，不再充当授权。

负例覆盖：

- “只能通过源码定位六个问题，不要修改任何文件。”
- “审查并指出需要修复的十个缺陷。”
- “无需修改源码，只给出修复建议。”

这些请求的辅助模型调用次数为 0，工作区文件内容不变。回归在 `test/bounded-patch.test.mjs`。

禁止修改范围在每次提交前重新检查：`forbiddenSourceFile()`、测试路径、发布视图外文件、源码根外路径。`package.json.files` 只用于选择初始上下文，不授予写权限。

### 条件写入

`bounded-patch.mjs` 删除普通 `write` 路径，全部写入改经 `native-cas.apply()`：

1. `native-files.mjs` 取得文件身份与原生版本。
2. 按该版本读取完整源码。
3. 在原始正文上构造候选修改。
4. 无副作用语法验证。
5. 以原始版本条件提交。
6. 版本不匹配时拒绝覆盖并交回主 Agent。
7. 原生读回记录版本、SHA-256 与效果状态。

`native-files.mjs` 新增 `list()`，目录读取走宿主 `listDir/lstat`，保留真实类型与版本。源码读取使用宿主 `fs` 服务；无宿主时只保留测试可注入的回退路径。

### 语法检查

`syntaxIssue()` 改为 `syntaxCheck()`，返回 `passed | failed | unavailable | unsupported`。JavaScript 临时文件放在 `os.tmpdir()` 下独立目录并在 `finally` 清理。语法通过不代表行为正确，结果单独记录。

## 二、状态机与工具保留

`bounded-patch.mjs` 新增：

- `patchStatus`: `not-applicable | partial | completed | failed | aborted`
- `taskStatus`: 固定 `unknown`
- 单文件 `effectState`、`verified`、前后版本、哈希、语法状态
- `rejected`、`followup`、`unverified`、`sourceCoverage`

`done` 只保留为兼容字段，不再推导任务完成。`index.mjs` 删除三处清空工具逻辑和两处依赖 `done` 跳过维护的分支。完成、部分、失败、取消都向主 Agent 保留工具与结构化交接。

取消时返回 `aborted`，已提交修改及其证据保留。回归覆盖：单文件成功其余失败、并发变化、全部候选拒绝、功能关闭、写入后异常、取消。

## 三、预算

`model.mjs` 的 `reserveBudget()` 同时检查 scope 与 task 两级预算，并在同一串行事务中持久化。`bounded-patch.mjs` 不再本地累加 `boundedAuxiliaryTokens`，全部轮次与重试共享任务预算 1,500,000 Token / 6 次调用。

- 完整可信用量按实际结算。
- 部分可信用量保留下界与未知风险。
- 用量未知时保留预留并停止后续调用。
- 失败请求不因缺少正常 JSON 被当作免费。
- 预算记录保存失败时不发出请求。

本地字符估计不是服务端分词，预算只约束插件自身调用，不能描述为服务端硬限制。

## 四、请求账本

`effect-observer.mjs`：

- 删除 `pendingRequestRows.slice(-32)`。
- 新增 `pendingStartRows`、`pendingLinkRows`、`finishQueue`、`finishFailed`、`persistenceUnavailable`、`persistenceConflict`。
- `start()` 在前一条 finish 未持久化时拒绝发出下一次请求，错误标记 `effectsDispatched:false`。
- 无遥测目录时不阻塞正常任务，但保持记录待提交并标记 `complete:false`。
- append 抛错后按 schema + requestId 判重；同一稳定身份但内容不同则标记冲突，不覆盖、不丢弃待提交行。
- `load()` 恢复 start/link，并统计未结算 start。
- `flush()`、`disposeAgent()`、`dispose()` 重试全部队列。

故障注入覆盖：连续 40 次失败、finish 失败阻断下一次 start、flush/dispose 恢复、卸载时待提交、完整行写出后抛错、start/link 单独失败、冲突身份、无存储。

## 五、计价与历史

`context-economics.mjs`：

- 显式绑定 provider/model 的配置价标记 `basis:'exact-route'`。
- 发布价只作 `reference-rate`，进入独立的 `referenceCostByCurrency`。
- 无价格标记 `unavailable`。
- `summary` 输出 `referencePricedRequests`、`referenceCostLowerBound`、`costObservation.basis`。
- 失败请求的已知费用下界保留在 `failedKnownCostByCurrency`。

`history-hygiene.mjs`：`initialOutputView` 与 `testDigest` 复用已存储计划，稳定期内不因新的预测反复切换。定义摘要默认关闭，只有 `definitionSummary:"on"` 才额外注入；统计区分候选、实际发送、单次注入与累计注入，并注明信息组织不等于净收益。

`context-pruning.mjs`：来源优先。`transport` 只在调用来源可证明为 shell/程序执行时成立；来源不明时，`stdout/stderr` 形状的 JSON 保守保留。配置正文与传输结果同形的反例已覆盖，live history 与 stage checkpoint 两条路径都传入来源标记。

## 六、文件身份与证据等价

删除按 `process.platform` 强制小写：

- `history-hygiene.fileKey`
- `observation-ledger.fileKey`
- `execution-dependencies.key`
- `request-working-set.normalizeText`
- `runtime.realKeyOf`
- `index.sourceKey`
- `quality-review` 三处 `fileKey`
- `task-flow` 的 `normalize`、`sourcePathKey`
- `trajectory-audit.normalizeFile`
- `source-project` 两处模块身份
- `ptc-patterns.workspaceKey`

归档条目继续按归档规则精确匹配；无法取得可靠宿主身份时采用保守策略。

`request-working-set` 证据等价键加入 `revision`、`complete`、`callId`、`seq`。命令执行和无版本读取不再仅凭相同命令与输出视为等价证据。

## 七、性能

`scripts/profile-default-path.mjs`（`npm run profile`）测量本地处理，不包含模型等待和工具执行。30 轮结果：

| 分段 | 均值 | p95 |
|---|---|---|
| `runtime.get` | 0.017 ms | 0.103 ms |
| 200 条源码路径键集合 | 0.190 ms | 0.651 ms |
| 50 文件请求载荷序列化 | 0.046 ms | 0.054 ms |
| 本地文本 Token 估计 | 0.0016 ms | 0.0026 ms |
| 无存储 effect 快照 | 0.067 ms | 0.137 ms |
| 上下文经济学摘要 | 0.018 ms | 0.066 ms |
| 原生文件服务构造 | 0.0014 ms | 0.0034 ms |
| 有界补丁构造 | 0.0056 ms | 0.0077 ms |

这些数据只覆盖本地函数开销，不证明整体任务性能，也不替代真实模型对照。

## 尚未完成

- 真实模型对照未在本轮执行。`opencode-go/deepseek-v4.1-flash` 的 High/Max 对照与费用结论不在本次整改范围内。
- `boundedPatch` 的项目规模、文件数、源码字节和缺陷数量只表示机制适用性；本轮没有跨项目验证这些阈值，不能据此宣称通用效率收益。
- 请求开始记录在持久化不可用且进程被强制终止时无法恢复；状态只标记不完整。
- 本地 Token 估计不是服务端分词；预算不能视为服务端硬限制。
- `rc2-native-conditional-write` 是兼容标识，现覆盖 0.2.1-rc.4 之外的 rc.1/rc.2 同版本组合；名称未改，避免破坏已有记录。
- 性能数据为单机单次采样，未覆盖模型等待、原生工具执行和真实历史增长。
