# 1.1.1 迁移说明（从 1.1.0 升级）

## 从 1.0.1-dev 系列升级

1. 停止使用旧版本的宿主会话或让宿主完成当前生命周期。
2. 保留现有工作区的 `.dsh/work-evidence/config.json` 和会话策略文件；升级前另存一份 `config.json`，以便回退时恢复原始设置。1.1.1 会读取已有 JSON，不要求重建。
3. 用 1.1.1 发布包替换插件目录。
4. 保留或重建 FastEdit Python 环境：发布 tarball 不含 `.fastedit-venv`，而 `runtime.mjs` 默认把 `fastEditPython` 指向该目录。如果旧环境位于被替换的插件目录内，替换后 Java 精确编辑会显示不可用，需把 `fastEditPython` 指向保留的解释器或重建该虚拟环境。
5. 在插件目录安装发布依赖：发布 tarball 不含 `node_modules`。若宿主不提供 `fflate 0.8.3`，归档读取会显示 `archive-decoder-unavailable:fflate`，`dependencies.archiveDecoder.available` 为 `false`。执行 `npm install --omit=dev`（或把 tarball 装入宿主依赖树并确认 `fflate` 可解析）后再继续。
6. 重启宿主，先用 `/work-evidence status` 和 `/work-evidence features` 查看配置、依赖和有效状态。
7. 确认 `dependencies.archiveDecoder.available` 为 `true`。仅确认 `fflate` 包可安装不够；插件或宿主无法实际加载解码器时，归档读取仍会返回 `ARCHIVE_DECODER_UNAVAILABLE`。
8. 需要完整工具面时显式执行 `/work-evidence feature toolSurface full`；默认仍为 compact。

## 配置行为

- `qualityReview`、`completionNotice`、`requestProjection`、`projectionRestore`、`swLedger`、`swEviction`、`deferPressureCompaction`、`stubSummary`、`structuredCalls`、`nativeProgramReuse`、`nativeReasoningReplay` 和 `finalJsonResultGuard` 默认关闭。需要阶段摘要后的自动继续时，显式开启 `completionNotice`。`stageWorkingSet` 默认开启，但仅在请求投影与投影恢复同时开启、`toolSurface:full` 下显式 `work_state` stage，或关闭 `executionTriage` 时有可达消费者。升级前的显式值保留。
- `fastEditEnabled` 关闭时，`fastedit_java` 返回 `deopt` 和 `fastedit-disabled`，不改文件；在同一会话重新开启后恢复调用。`defaultResponseView` 默认 `reference-if-visible`，需要完整来源正文时设置 `full`，设置值同样保留到后续会话。
- `contextPruningPolicy` 只接受 `forecast`；`compactionTiming` 只接受 `native`；旧值会安全归一到这两个有效值。
- `mode` 不再设置运行模式。Ultra 使用质量模式，非 Ultra 在 `aggressiveMode` 开启时使用激进模式。
- 旧布尔设置 `programHistory`、`reasoningHistory`、`ledgerFoldPlan`、`ledgerFoldWrite`、`executionAdvice`、`finishAdvice`、`taskEffort`、`nativeReadView`、`nativeExecutionEvidence`、`cacheOrderedStub` 和 `archiveEntries` 保留读取兼容并固定为关闭，不会重新接线。
- `DSH_EXPERIMENT_DEFER_COMPACTION`、`DSH_EXPERIMENT_STUB_SUMMARY` 和 `DSH_EXPERIMENT_STUB_DEDUP` 不再是稳定行为开关；请使用显式工作区设置或代码选项。

## 依赖与宿主

发布声明只包含实际验证的宿主版本。若使用的宿主不在声明范围，先不要启用插件自动处理；记录版本并完成对应宿主验证后再升级声明。`fflate 0.8.3` 的归档行为已按发布依赖验证，宿主内其他 `fflate` 版本不能替代该证据。

## 验收后

安装后的插件检查与仓库测试分开执行：

1. 在安装后的插件目录运行 `npm run check`，并按 [发布门禁](RELEASE-GATES-1.1.1.md) 核对独立安装的入口、版本和依赖。
2. 检出与发布包对应的候选 SHA。发布包不包含 `test/`，仓库 Node 测试和双宿主关键路径检查须在该仓库 checkout 中按发布门禁执行。
3. 保留任何失败的原错误和来源，不删除测试或降低断言。
4. 按 [发布门禁](RELEASE-GATES-1.1.1.md) 记录同一候选 SHA 的安装检查与仓库测试结果。
