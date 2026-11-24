# 系统性缺陷整改记录（2026-11-25）

对象：`feat/v04-windows-bash`，当前提交 `04d3fac`。本文记录系统性整改和第三轮独立审查后当前成立的行为、验证方式和真实限制；不把离线测试、脚本化性能循环或参考费率当成真实模型费用与质量结论。

## 验证结果

| 项 | 结果 |
|---|---|
| 语法检查 | `npm run check`，192 个 JavaScript 文件通过 |
| 全量单测 | `npm test`，1092 项，1091 通过，0 失败，1 项按宿主能力跳过 |
| 跳过原因 | 当前宿主三包均为 `0.2.2-rc.1`，条件写入后端可用；只描述“后端缺失”的用例按设计跳过 |
| 打包安装 | `test/package-install.test.mjs` 通过；离线安装不拉宿主 peer，安装副本可加载 |
| 声明文件加载 | `test/host-package-load.test.mjs` 通过；95 个声明文件，45 个功能项，无阻塞项 |
| 宿主兼容 | `test/host-compatibility.test.mjs` 通过；声明与宿主运行时一致 |
| 宿主路径性能 | `evidence/profile-host-path-20261125.json`；3 轮，覆盖插件关闭、默认插件、核心机制消融和统计关闭 |
| 本地微基准 | `evidence/profile-default-path-20261125.json`；30 轮，仅本地函数分段 |
| 条件写入负例 | 未知文件服务按不可用返回，不进入读取或写入；见 `test/native-cas.test.mjs` |
| 远端同步 | 文档提交 `5ea21d2` 已推送 `origin/feat/v04-windows-bash`；本记录所述代码行为仍对应 `04d3fac` |

## 反向验证

对关键门禁临时撤销防护后运行对应测试，确认测试失败，再恢复实现：

| 门禁 | 临时撤销 | 结果 |
|---|---|---|
| 明确写入授权 | `sourceOnlyMaintenanceTask()` 不再检查 `intent.writeAuthorized` | `task detection...` 失败：没有写入授权的请求进入有界补丁 |
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

写入范围按明确的肯定范围解析。父子范围同时出现时，嵌套禁止范围优先；绝对路径、符号链接别名和未解析目录按保守结果处理，不能把项目根误当成授权。引用的修改指令只是待审查文本，不构成肯定授权。只读测试文件始终不可写。源码包会记录隐藏项、跳过目录、非源码文件、遍历预算和未知遗漏数；覆盖不完整时不能宣称已检查全项目。

### 条件写入

`bounded-patch.mjs` 删除普通 `write` 路径，全部写入改经 `native-cas.apply()`：

1. `native-files.mjs` 取得物理文件身份、`targetKey` 与原生版本。
2. 按该版本读取完整源码，记录原始字节哈希、BOM 与换行形式。
3. 在原始正文上构造候选修改。
4. 无副作用语法验证。
5. 语法检查后再次确认物理身份、版本和原始字节未变化。
6. 以原始版本条件提交。
7. 版本、身份或正文不匹配时拒绝覆盖并交回主 Agent。
8. 原生读回记录新版本、`targetKey`、SHA-256 与效果状态。

`native-files.mjs` 新增 `list()`，目录读取走宿主 `listDir/lstat`，保留真实类型与版本。源码读取使用宿主 `fs` 服务；无宿主时只保留测试可注入的回退路径。

### 语法检查

`syntaxIssue()` 改为 `syntaxCheck()`，返回 `passed | failed | unavailable | unsupported`。语法检查只经宿主 `subprocess` 服务执行，不直接 `spawn` 子进程；用户禁止执行、取消信号或宿主服务不可用时返回不可用，不绕过限制。JavaScript 临时文件放在 `os.tmpdir()` 下独立目录并在 `finally` 清理。语法通过不代表行为正确，结果单独记录。

## 二、状态机与工具保留

`bounded-patch.mjs` 新增：

- `patchStatus`: `not-applicable | partial | completed | failed | aborted`
- `taskStatus`: 固定 `unknown`
- 单文件 `effectState`、`verified`、前后版本、哈希、语法状态
- 原始提案、`rejected`、`followup`、`unverified`、`unknownEffects`、`sourceCoverage`、未解析范围为独立字段

`done` 只保留为兼容字段，不再推导任务完成。只有 `patchStatus:"completed"` 才表示补丁阶段完成；部分、失败、取消、未知写入效果和待接续都保留 `done:false`。`index.mjs` 删除三处清空工具逻辑和两处依赖 `done` 跳过维护的分支。完成、部分、失败、取消都向主 Agent 保留工具与结构化交接。

取消时返回 `aborted`，已提交修改及其证据保留。补丁提案要求严格 JSON；宽松恢复不能改变待写入源码的转义。回归覆盖：单文件成功其余失败、并发变化、全部候选拒绝、功能关闭、写入后异常、取消、未知写入效果、语法检查前后变化和严格 JSON。

## 三、预算

`model.mjs` 的 `reserveBudget()` 同时检查 scope 与 task 两级预算，并在同一串行事务中持久化。记录不使用固定条数淘汰有效 scope；旧 scope 再次使用不会重置。文件更新采用原子写入，进程内锁和并发预留保证同一额度不会被重复消费。派发前失败会退还预留；部分可信用量只记录下界。`bounded-patch.mjs` 不再本地累加 `boundedAuxiliaryTokens`，全部轮次与重试共享任务预算 1,500,000 Token / 6 次调用。

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
- 普通模式在遥测失败时降级，不阻塞正常任务，但保持记录待提交并标记 `complete:false`。
- `strictObservability` 默认关闭；开启后，请求开始记录无法持久化时在派发前拒绝，并标记 `effectsDispatched:false`。
- append 抛错后按 schema + requestId 判重；同一稳定身份但内容不同则标记冲突，不覆盖、不丢弃待提交行。
- `load()` 恢复 start/link，并统计未结算 start。
- `flush()`、`disposeAgent()`、`dispose()` 重试全部队列；异步 finish 未落盘时显示 `finishPending`，不提前报告 `complete`。
- 插件卸载不会清除未结算的实际 start；明确标记 `not-dispatched` 的记录不计为幽灵消费。

故障注入覆盖：连续 40 次失败、普通与严格模式、finish 未落盘、flush/dispose 恢复、卸载时待提交、完整行写出后抛错、append 成功后回读失败、start/link 单独失败、冲突身份、无存储和未派发。

## 五、计价与历史

`context-economics.mjs`：

- 显式绑定 provider/model 的配置价标记 `basis:'exact-route'`。
- 发布价只作 `reference-rate`，进入独立的 `referenceCostByCurrency`。
- 无价格标记 `unavailable`。
- `summary` 输出 `referencePricedRequests`、`referenceCostLowerBound`、`costObservation.basis`。
- 失败请求的已知费用下界保留在 `failedKnownCostByCurrency`。
- 参考价不能批准正常压缩或上下文改写；只有精确路由价可以进入正常经济性决策。容量紧急策略与正常经济性策略分开。
- 部分已知用量按可信字段记录费用下界；混合参考价、精确价和失败费用时分别报告覆盖率。

`history-hygiene.mjs`：`initialOutputView` 与 `testDigest` 复用已存储计划，稳定期内不因新的预测反复切换。定义摘要默认关闭，只有 `definitionSummary:"on"` 才额外注入；统计区分候选、实际发送、工具观察时注入和真实请求投影时注入，并注明信息组织不等于净收益。

`context-pruning.mjs`：来源优先。`transport` 只在调用来源可证明为 shell/程序执行时成立；来源不明时，`stdout/stderr` 形状的 JSON 保守保留。配置正文与传输结果同形的反例已覆盖，live history 与 stage checkpoint 两条路径都传入来源标记。

## 六、文件身份与证据等价

文件身份优先使用宿主物理身份与原生 `targetKey`；展示路径、归档条目和无法确认的路径分开处理。删除按 `process.platform` 强制小写：

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

归档条目继续按归档规则精确匹配。大小写、规范化、符号链接和 Windows 同一文件的别名都按物理身份归并。无法取得可靠身份时采用保守策略，相关旧证据失效，不能凭字符串不相等证明文件相互独立。

`request-working-set` 证据等价键加入 `revision`、`complete`、`callId`、`seq`。命令执行和无版本读取不再仅凭相同命令与输出视为等价证据。依赖扫描不完整或被截断时，不能基于部分依赖列表证明证据等价。

## 七、性能

`scripts/profile-host-path.mjs`（`npm run profile:host`）使用真实宿主循环、原生读取和 PowerShell 工具，运行 12 个请求、6 个文件、每文件 140 行。脚本化模型等待固定为 0，只测本地插件与宿主处理。结果在 `evidence/profile-host-path-20261125.json`：

| 模式 | 步耗时 p50 / p95 | `sendMs` p50 | 12 请求字符数 | 遥测 |
|---|---:|---:|---:|---|
| `plugin-off` | 6.68 / 9.36 ms | 77.06 ms | 940,183 | 无 |
| `plugin-default` | 27.83 / 575.28 ms | 867.86 ms | 940,886 | 36 行，43,181 字节，完整 |
| `core-only` | 22.48 / 569.38 ms | 813.09 ms | 940,886 | 36 行，40,210 字节，完整 |
| `accounting-off` | 16.68 / 563.25 ms | 750.63 ms | 940,886 | 文件缺失 |

该结果定位了插件默认路径的本机开销，不能证明供应商延迟、实际扣费或任务级费用收益。`scripts/profile-default-path.mjs`（`npm run profile`）的 30 轮结果仍只作为局部微基准：

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

微基准只覆盖本地函数开销。两类性能数据都不替代真实模型对照，也不能用参考费率推出实际账单。

## 尚未完成

- 审查后的真实模型小卷尚未执行。`EcoNative42` 和 `EcoNative44` 都早于 `04d3fac`，只能作为诊断样本，不能计入审查后连续达标。
- `boundedPatch` 的项目规模、文件数、源码字节和缺陷数量只表示机制适用性；本轮没有跨项目验证这些阈值，不能据此宣称通用效率收益。
- 请求开始记录在持久化不可用且进程被强制终止时无法恢复；状态只标记不完整。
- 本地 Token 估计不是服务端分词；预算不能视为服务端硬限制。
- `rc2-native-conditional-write` 是兼容标识，现覆盖 0.2.1-rc.4 之外的 rc.1/rc.2 同版本组合；名称未改，避免破坏已有记录。
- 宿主路径性能为单机 3 轮，模型等待为 0，未覆盖真实增长历史、供应商延迟和实际账单。
