# 系统性缺陷整改记录（2026-11-25）

对象：`feat/v04-windows-bash`，当前审查关闭提交 `88b4ea6`。本文记录系统性整改和第三轮独立审查后当前成立的行为、验证方式和真实限制；不把离线测试、脚本化性能循环或参考费率当成真实模型费用与质量结论。

## 验证结果

| 项 | 结果 |
|---|---|
| 语法检查 | `npm run check`，194 个 JavaScript 文件通过 |
| 全量单测 | `npm test`，1102 项，1101 通过，0 失败，1 项按宿主能力跳过 |
| 跳过原因 | 当前宿主三包均为 `0.2.2-rc.1`，条件写入后端可用；只描述“后端缺失”的用例按设计跳过 |
| 并发波动 | 首次并发全量出现 1 次 `host-node-fallback` 的解释器约束用例失败；该文件单独运行 10/10，第二次全量通过。根因未定位，保留为测试稳定性风险，不写成已修复 |
| 打包安装 | `test/package-install.test.mjs` 通过；离线安装不拉宿主 peer，安装副本可加载 |
| 声明文件加载 | `test/host-package-load.test.mjs` 通过；95 个声明文件，45 个功能项，无阻塞项 |
| 宿主兼容 | `test/host-compatibility.test.mjs` 通过；声明与宿主运行时一致 |
| 宿主路径性能 | `evidence/profile-host-path-20261125-refresh.json`；3 轮、21 请求/轮，覆盖插件关闭、默认插件和四项单变量消融；旧合并消融与参数错误数据不再使用 |
| 本地微基准 | `evidence/profile-default-path-20261125.json`；30 轮，仅本地函数分段 |
| 条件写入负例 | 未知文件服务按不可用返回，不进入读取或写入；见 `test/native-cas.test.mjs` |
| 远端同步 | 本次审查修复与随附记录提交后推送 `origin/feat/v04-windows-bash` |

## 第三轮审查残余关闭

本轮补充整改不改变插件默认开关或实验提示词，只修复审查报告中的计数、身份和证据链残余，并补齐可复现的本地分段 profiling。

| 审查点 | 当前实现 | 证据 |
|---|---|---|
| 部分已知用量的费用下界 | 只有未形成完整已知费用的请求才进入下界；完整请求不再重复累加 | `test/context-economics.test.mjs`，覆盖率测试同时断言 `lowerBound` 与 `unpriced` |
| 覆盖率重复计数 | `coverage.unpriced` 扣除完整、参考、失败已知和两类下界请求，避免同一请求被计两次 | 同一测试断言 `requests:2, exactRoute:1, lowerBound:1, unpriced:0` |
| 定义摘要累计注入 | `cumulativeInjectedChars`/`netChars` 使用真实请求投影量；工具观察量保留为 `observedNetChars` | `test/history-protection.test.mjs` |
| 缓存历史初始视图 | 首次发送仍可使用独立的初始 grep 视图；已缓存历史尚未投影时必须通过 `allowed('historyOutput')` 经济性门禁，拒绝时保留原文并记录一次 denied 决策 | `test/history-protection.test.mjs` 的首次发送与缓存历史两组断言 |
| PTC 工作区文件身份 | 历史会话 cwd 与当前工作区使用宿主物理路径身份，符号链接/目录别名不会把同一工作区拆开 | `test/ptc-workspace-identity.test.mjs` |
| 严格 JSON 提案 | 辅助提案只按严格 JSON 解析；非法转义不会被宽松恢复为另一段待写源码，失败后才进入一次重试 | `test/bounded-patch.test.mjs` 的 strict JSON 反例 |
| 提交前请求身份 | 主机暴露当前用户请求时，提交前再次比较请求身份和写入授权；主机在后续工具阶段不暴露时，保留启动时请求 id 与逐文件 Native CAS/身份检查，并明确这一证据限制 | `bounded-patch.mjs` 的 `validateCommit` |
| 真实默认路径 profiling | 宿主循环、原生 read/grep/pwsh、增长历史、重复读取、一次失败读取、请求边界配置刷新和单变量消融均已采样；模型仍为脚本化零等待，不冒充供应商延迟或账单 | `scripts/profile-host-path.mjs`、`evidence/profile-host-path-20261125-single-factor.json`、`evidence/profile-host-path-20261125-refresh.json` |
| 预览写入不失效旧读取 | `verified_exec` 只预览或 deopt、且效果状态为 `none` 时，不把此前读取标记为过期；真实写入和未知效果仍按原规则失效 | `test/observation-ledger-freshness.test.mjs` |
| 超长行续读 | 响应预算裁掉后续行且首行本身被截断时，不再把“下一行”作为唯一恢复入口；达到 `lineTextMaximum` 时报告 `lineTextRecoveryLimited` | `test/evidence-archive.test.mjs` |
| 归档批次隔离 | 单个归档成员读取异常只返回该来源 `unavailable`，同批其它来源继续；宿主取消仍向外抛出，不伪装成不可用 | `source-tools.mjs`；归档取消边界已由 `test/evidence-archive.test.mjs` 覆盖，批次异常路径依赖注入边界 |
| 条件写入能力探测 | 原生条件写入探测失败直接报错，不再被当作“不支持宿主”；未编辑分支断言 `nativeSupported === false`，防止 rc.2 回归被错误接受 | `test/host-workflow-combinations.test.mjs` |
| CRLF 预设选择 | 预设选择器同时接受 LF 和 CRLF 检出；新增 CRLF 回归 | `test/flash1017-preset.test.mjs` |
| 失败请求基线 | 出错但无 `failureCode` 的 finish 不能替换曝光基线 | `test/context-economics.test.mjs` |

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

`feature-control.mjs` 的就绪判断与上述执行条件一致：

- `projectionPricing` 为空时报告 `requires-setting:projectionPricing`，不再把发布价描述为可用价格。
- 有价格但路由不精确时报告 `route-price-not-exact`。
- 找不到对应价格时报告 `route-price-unavailable`。
- `historyHygiene`、`contextPrune`、`contextProtocol`、`requestProjection` 以及开启 `compressionControl` 时的 `swEviction` 使用同一条件。

审查后的 `EcoNative45`–`EcoNative49` 实际配置为 `projectionPricing: []`。五轮共 349 个主请求、0 个辅助模型请求；`historyOutput` 532 次决策中只有 5 次初始未发送视图应用，527 次因参考价被拒；`contextPrune` 109 次决策中 39 次因参考价被拒，正常改写 0 次。因此这些轮次的费用下降不能归因于正常历史压缩或源码裁剪。可复核数据见 `evidence/feature-effects-h26-20261125.json`。

`history-hygiene.mjs`：`initialOutputView` 与 `testDigest` 复用已存储计划，稳定期内不因新的预测反复切换。首次发送的初始 grep 视图仍是独立规则；已进入缓存历史且尚未投影的视图必须通过 `allowed('historyOutput')` 经济性门禁，不能绕过价格判断。定义摘要默认关闭，只有 `definitionSummary:"on"` 才额外注入；统计区分候选、实际发送、工具观察时注入和真实请求投影时注入，并注明信息组织不等于净收益。

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

`scripts/profile-host-path.mjs`（`npm run profile:host`）使用真实宿主循环、原生 `read`/`grep`/`pwsh`、10 个文件、每文件 180 行、7 次重复读取和 1 次失败读取，每轮 21 个请求。脚本化模型等待固定为 0。旧的 `accounting-off` 同时关闭十项配置，且 `pwsh` 调用缺少必填 `description`：关闭组被宿主在参数校验阶段拒绝，插件组的参数兼容逻辑补救了调用，因此旧数据不能用于执行能力或 4.53 倍耗时比较。现行脚本使用同一 `pwsh` 路径和合法参数，两组均为 3/3 成功；消融改为单变量模式。

配置刷新改动前，默认插件每 3 轮读取 `config.json` 1080 次；每轮 18 次 `read` 的总耗时比关闭组高约 230 ms。`runtime.init` 曾在每个 `pre-step` 和读工具派发时重读工作区与会话配置。现在 `init` 只装载一次，`refresh` 只在新模型请求、状态查询和控制命令时重读；配置仍从下一次模型请求生效。改动后的同条件 3 轮结果：

| 模式 | `sendMs` p50 / p95 | `read` p50 | 3 轮配置操作 / 耗时 | 3 轮遥测操作 / 耗时 |
|---|---:|---:|---:|---:|
| `plugin-off` | 1046.25 / 1135.73 ms | 5.10 ms | 0 / 0 ms | 0 / 0 ms |
| `plugin-default`（改动后） | 1311.92 / 1341.75 ms | 9.12 ms | 189 / 31.02 ms | 387 / 567.90 ms |
| `plugin-default`（改动前） | 1770.95 / 1856.51 ms | 19.15 ms | 1080 / 247.59 ms | 387 / 526.01 ms |

每 3 轮配置操作减少 82.5%，读取总耗时从 1020.61 ms 降到 500.23 ms；相对关闭组的额外读取开销从约 691.64 ms 降到约 209.27 ms。剩余本机开销主要在 3 轮 387 次遥测写入，平均每次读取仍多约 3.9 ms。单关 `requestAccounting`、`historyHygiene`、`stepPacing` 或 `contextProtocol` 未显著降低配置或遥测次数；这些开关不是当前读取额外开销的主因。数据见 `evidence/profile-host-path-20261125-single-factor.json`、`evidence/profile-host-path-20261125-refresh.json`。

缓存前缀离线检查读取原生会话事件并按相邻请求重建可见消息序列。H26 关闭组 168 次相邻比较全部为追加，插件 45–49 共 343 次比较也全部为追加，缓存读取下降 0 次；关闭组最小/中位缓存读占前一请求提示 Token 的比例为 98.61% / 99.96%，插件为 98.65%–99.62% / 99.95%–99.96%。5 次 `historyOutput` 改写都发生在消息首次送达前，没有改写已进入缓存的历史。H26 的费用差来自请求数、累计输入、缓存读取量和输出量，不是插件造成的缓存断点。汇总见 `evidence/cache-prefix-h26-20261125.json`。会话事件不保留宿主生成的完整系统提示和工具 schema 正文，因此该结果不能替代供应商侧缓存日志。

`scripts/profile-default-path.mjs`（`npm run profile`）的 30 轮结果仍只作为局部微基准：

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

- 审查后真实模型小卷已执行到 `EcoNative49`；45–49 的连续三次达标记录见交接页。本节不把该结果当作审查报告级别以上的质量证明。
- PR #12 的旧未解决线程尚未全部关闭。最新手动审查已触发，但 CodeRabbit 因本 PR 124 个文件超过其 100 个文件上限继续跳过；不能把“已触发”写成“已审查”。
- `boundedPatch` 的项目规模、文件数、源码字节和缺陷数量只表示机制适用性；本轮没有跨项目验证这些阈值，不能据此宣称通用效率收益。
- 请求开始记录在持久化不可用且进程被强制终止时无法恢复；状态只标记不完整。
- 本地 Token 估计不是服务端分词；预算不能视为服务端硬限制。
- `rc2-native-conditional-write` 是兼容标识，现覆盖 0.2.1-rc.4 之外的 rc.1/rc.2 同版本组合；名称未改，避免破坏已有记录。
- 宿主路径 profiling 为单机 3 轮、脚本化模型零等待；覆盖增长历史和持久化，但不覆盖供应商延迟、辅助模型等待或实际账单。请求账本在主机的后续工具阶段可能不再暴露当前用户消息，此时只能保留启动时请求 id 和逐文件 Native CAS/身份检查。
