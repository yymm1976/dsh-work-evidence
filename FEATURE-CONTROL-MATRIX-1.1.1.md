# 功能入口成熟度矩阵

范围：当前 1.1.2 候选 `feature-control.mjs` 的 44 个实际入口。以下候选仍默认关闭：原生条件编辑、文件概况、JSON 选择。宿主 Node 回退、Shell 程序引用和原样检查重执行也默认关闭。真实任务与消融未完成的候选不记为成熟。

| 入口 | 状态 | 启停与依赖 | 运行、恢复和组合证据 | 文档与迁移 |
|---|---|---|---|---|
| `enabled` | 成熟默认开启 | 工作区总开关；会话可覆盖 | `host-control-state.test.mjs` 验证启停和清理 | `README.md`、`MIGRATION-1.1.1.md` |
| `aggressiveMode` | 成熟默认开启 | 模式选择；关闭时保留基础路径。旧工作区 `mode:"default"` 且未显式设置时强制关闭 | `host-modes.test.mjs` 验证模式切换 | `README.md` |
| `selfIndex` | 成熟默认开启 | 源码索引；依赖本地读取 | `host-candidates.test.mjs` 验证索引入口 | `README.md` |
| `fastEditEnabled` | 候选，默认关闭 | 需 `opsAdapters:true`、Python、`ops_stat` 和授权 shell；未启用 OPS 适配时返回 `ops-adapters-disabled` | `feature-control.test.mjs` 覆盖新默认与依赖；宿主级关闭/恢复需在 OPS 宿主复核 | `README.md`、`MIGRATION-1.1.2.md` |
| `stateLedger` | 成熟默认开启 | 账本基础能力 | `host-state.test.mjs` 验证记录与释放 | `README.md` |
| `stateInform` | 成熟默认开启 | 依赖 `stateLedger` | `host-state.test.mjs` 验证适用状态 | `README.md` |
| `completionNotice` | 成熟显式开启 | 默认关闭；只在仍有可执行事项时启用 | `host-features.test.mjs`、`host-delivery-combinations.test.mjs` 验证不增加默认请求 | `README.md` |
| `archiveReadRouting` | 成熟默认开启 | 依赖本地文件系统和归档解码 | 归档测试、`host-source-options.test.mjs` 验证来源路径和失败恢复 | `README.md` |
| `readArgumentRecovery` | 成熟默认开启 | 本地读取参数校正 | `host-source.test.mjs` 验证别名和拒绝分支 | `README.md` |
| `requestAccounting` | 成熟默认开启 | 记录主、压缩和辅助请求 | `host-state.test.mjs`、实验原始账本 | `README.md` |
| `evidenceViews` | 成熟默认开启 | 来源正文可见时提供引用视图 | `host-source-options.test.mjs` 验证正文和引用切换 | `README.md` |
| `memberParsing` | 成熟默认开启 | 依赖文件系统和可用解析器；Java 语法范围，解析器不可用时词法回退；其他语言使用文本窗口 | `host-source-options.test.mjs`、Java 成员测试 | `README.md` |
| `mavenSourceBinding` | 成熟默认开启 | 依赖归档解码和坐标匹配 | `host-source-options.test.mjs`、Maven 来源测试 | `README.md` |
| `contextProtocol` | 成熟默认开启 | 处理可恢复旧工具正文 | `host-context-combinations.test.mjs`、`host-compaction.test.mjs` 验证正文、压缩与恢复 | `README.md` |
| `historyHygiene` | 成熟默认开启 | 依赖历史回收入口；异常时停用自身折叠。测试回执覆盖 pytest、ruff、compileall、gradlew/gradle/mvn 和带完整 TAP 摘要的 `node --test`；无摘要、截断、spill 或用户要求完整输出时不投影 | `host-history.test.mjs` 验证折叠和恢复；`test-output-hygiene.test.mjs` 验证测试输出回执、TAP 摘要边界、截断与召回边界；`history-full-output-request.test.mjs` 验证只有真实用户消息可停用回执 | `README.md` |
| `nativeVerifiedEdits` | 候选，默认关闭 | 限定 rc.2 原生 tools、LocalFileSystem 或官方 SandboxedFileSystem；沿原生 write 权限路径附带版本条件。旧宿主或工具替换时明确拒绝该候选；OPS CAS 路径需 `opsAdapters:true`，否则明确 deopt | `native-cas.test.mjs` 覆盖创建、替换、BOM/CRLF、并发、权限、逐文件成功和失败状态、延迟注册及真实 PTC；真实任务与消融待完成 | 当前候选尚未发布 |
| `fileProfiling` | 候选，默认关闭 | 依赖原生文件服务的版本、stat 和字节范围读取；入口 `file_profile` | `file-profile-core.test.mjs`、`file-profile.test.mjs` 覆盖 CSV、UTF-8、抽样/全量、预算与并发；真实触发及消融待完成 | `RELEASE-NOTES-1.1.2.md`、`MIGRATION-1.1.2.md` |
| `structuredJson` | 候选，默认关闭 | 依赖原生有界字节读取和版本；入口 `structured_json` | `json-pointer.test.mjs`、`structured-json-core.test.mjs`、`structured-json.test.mjs` 覆盖指针、数值规则、行号、短读及真实 PTC；真实任务及消融待完成 | `RELEASE-NOTES-1.1.2.md`、`MIGRATION-1.1.2.md` |
| `ledgerReceipt` | 成熟默认开启 | 依赖可回收历史和来源正文 | `host-source-options.test.mjs`、`host-acp-combinations.test.mjs` 验证短回执 | `README.md` |
| `ledgerUnresolved` | 成熟默认开启 | 保留真实未解决项，不推断完成 | `host-state.test.mjs` 验证状态传播 | `README.md` |
| `swLedger` | 成熟显式开启 | 默认关闭；为重复结果折叠提供记录 | `sw-default.test.mjs`、上下文组合测试 | `README.md`、`MIGRATION-1.1.1.md` |
| `swEviction` | 成熟显式开启 | 依赖 `swLedger` 和历史回收 | `sw-default.test.mjs` 验证启停和释放 | `README.md`、`MIGRATION-1.1.1.md` |
| `requestProjection` | 成熟显式开启 | 默认关闭；依赖 `projectionRestore`、回收入口 | `host-projection.test.mjs` 验证隐藏、恢复和锚点 | `README.md`、`MIGRATION-1.1.1.md` |
| `projectionRestore` | 成熟显式开启 | 依赖 `requestProjection` | `host-projection.test.mjs` 验证恢复失败清理 | `README.md`、`MIGRATION-1.1.1.md` |
| `compressionControl` | 成熟默认开启 | 协调原生压缩和来源恢复 | `compression-control.test.mjs`、`host-context-combinations.test.mjs` | `README.md` |
| `deferPressureCompaction` | 成熟显式开启 | 默认关闭；依赖 `compressionControl` 和原生压缩 | `host-context-combinations.test.mjs` 验证延后与恢复 | `README.md`、`MIGRATION-1.1.1.md` |
| `stubSummary` | 成熟显式开启 | 默认关闭；依赖回收、原生压缩（`native-compaction-not-attached`）和完整当前状态 | `host-context-combinations.test.mjs`、`host-compaction.test.mjs` | `README.md`、`MIGRATION-1.1.1.md` |
| `executionTriage` | 成熟默认开启 | 失败位置和程序版本记录 | `task-flow-execution.test.mjs`、`host-flow.test.mjs` | `README.md` |
| `nativeProgramReuse` | 成熟显式开启 | 默认关闭；依赖 `executionTriage`，只在 PTC 工具模式下生效 | `program-reference.test.mjs`、`host-workflow-combinations.test.mjs` | `README.md`、`MIGRATION-1.1.1.md` |
| `hostNodeFallback` | 候选，默认关闭 | 仅接管未指定或继承解释器的 Node `work_exec`；依赖 `work_exec`、平台 Shell、可写会话，Bash 还需 `shellEnv`。会话提及解释器、SEA、探测失败、超时、重复或不明确时不自动回退 | `host-node-fallback.test.mjs`、`inline-script-reference-recovery.test.mjs` 覆盖来源、权限、只读与未知探测。23981 的四臂实验只含一个已见合成题，on 平均费用低 27.0035%，但首组 on 高于 off；8da 工程测试不能移作模型收益 | `README.md`、`MIGRATION-1.1.2.md`、`ROLLBACK-1.1.2.md` |
| `nativeShellScriptReuse` | 候选，默认关闭 | 依赖 `work_exec`、平台 Shell、可写会话，Bash 还需 `shellEnv`。只接受同一会话原 Bash 中单个字面量 Python/Node stdin 程序、单引号 heredoc 和受支持参数 | `native-shell-script.test.mjs`、`host-native-shell-reuse.test.mjs` 覆盖解析、文件身份、只读和打包；0580 定向 29/29 仅为工程证据。020e 四臂均为 10/10，on 平均费用高 31.7756%；默认启用已拒绝，8da 无对应模型研究 | `README.md`、`MIGRATION-1.1.2.md`、`ROLLBACK-1.1.2.md` |
| `probeReplay` | 候选，默认关闭 | 依赖 `executionTriage`、`work_probe` 和同一会话可恢复的原调用及结果；当前文件、环境、PATH 与权限重新生效，保存到工作区的 JSON 不能提供来源 | `host-probe-replay.test.mjs`、`probe-execution-facts.test.mjs` 覆盖原失败、来源、后台、结算及 live/cold 投影；8da 定向 144/144 仅为工程证据。5029 两臂均为 31/31、均 5 请求，on 费用高 8.0216%；不证明净益 | `README.md`、`MIGRATION-1.1.2.md`、`ROLLBACK-1.1.2.md` |
| `structuredCalls` | 成熟显式开启 | 默认关闭；依赖 `executionTriage`，只在 PTC TypeScript 函数体运行时生效 | `host-structured-calls.test.mjs` 验证参数和普通路径 | `README.md`、`MIGRATION-1.1.1.md` |
| `nativeReasoningReplay` | 成熟显式开启 | 默认关闭；要求匹配 DeepSeek 工具历史 | `native-reasoning-replay.test.mjs` 验证未知、加密、回放和禁用恢复 | `README.md`、`MIGRATION-1.1.1.md` |
| `stageWorkingSet` | 成熟默认开启 | 消费者是 `work_state`：请求投影与投影恢复同时开启、`work_state` 可见，或关闭 `executionTriage` 时才可达 | `host-flow.test.mjs`、`default-path-consistency.test.mjs`、`host-context-combinations.test.mjs` | `README.md`、`MIGRATION-1.1.1.md` |
| `stepPacing` | 成熟默认开启 | 阶段缺口指引；最小任务不强行插入 | `host-flow.test.mjs`、`startup-readme.test.mjs` | `README.md` |
| `retainedCompute` | 成熟默认开启 | 缺失原生服务时报告并延后重试 | `host-retained-dependencies.test.mjs`、双宿主日志 | `README.md` |
| `finalJsonGuard` | 成熟默认开启 | 用户明确要求 JSON 时启用校验 | `final-json-result.test.mjs` | `README.md` |
| `finalJsonResultGuard` | 成熟显式开启 | 默认关闭；依赖 `finalJsonGuard` 和明确观察 | `final-json-result.test.mjs`、交付组合测试 | `README.md`、`MIGRATION-1.1.1.md` |
| `qualityReview` | 成熟显式开启 | 默认关闭；要求质量模式和可用复核路线 | `host-review-evidence.test.mjs`、`host-review-scope.test.mjs` | `README.md`、`MIGRATION-1.1.1.md` |
| `qualityReviewEffort` | 成熟显式参数 | 依赖 `qualityReview`；`auto/inherit/low/medium/high/max` 校验；默认 `auto` | `host-features.test.mjs` 验证 auto、inherit、低、中、高、max 和不可用档位 | `README.md` |
| `qualityReviewScope` | 成熟显式参数 | 依赖 `qualityReview`；`auto/full` 校验；默认 `auto` | `host-review-scope.test.mjs`、`host-delivery-combinations.test.mjs` | `README.md` |
| `toolSurface` | 成熟显式参数 | 默认 `compact`；显式 `full` 展开工程入口 | `host-source-options.test.mjs`、工具入口测试 | `README.md`、`MIGRATION-1.1.1.md` |
| `defaultResponseView` | 成熟显式参数 | 默认 `reference-if-visible`；可切换 `full`；依赖 `evidenceViews` | `host-source-options.test.mjs` 验证切换和正文保留 | `README.md`、`MIGRATION-1.1.1.md` |

## 终审结论

- 44 个入口均有配置和源码接线。`nativeVerifiedEdits`、`fileProfiling`、`structuredJson`、`hostNodeFallback`、`nativeShellScriptReuse` 和 `probeReplay` 仍为候选；前 3 项的真实任务与消融未完成，后 3 项只有已见合成研究且不能证明稳定净益。
- 23981e8、020e842 和 5029a09 的真实模型结果只属于对应源码。宿主 Node 回退的四臂结果不能证明稳定收益；Shell 程序引用的重复实验平均费用高 31.7756%；原样检查重执行高 8.0216%。这些结果不改 8da 正式成绩。
- 默认关闭的能力通过显式配置启用。缺少依赖时返回 `blocked`、`waiting` 或明确原因。
- 旧设置由 `runtime.mjs` 的 `RETIRED_SETTINGS` 固定关闭；迁移兼容和回退说明见 `MIGRATION-1.1.1.md`、`MIGRATION-1.1.2.md`、`ROLLBACK-1.1.1.md` 与 `ROLLBACK-1.1.2.md`。
- 仍需在最终候选 SHA 上重跑本矩阵引用的双宿主证据；当前矩阵不是发布通过声明。
