# 1.1.0 迁移说明

## 从 1.0.1-dev 系列升级

1. 停止使用旧版本的宿主会话或让宿主完成当前生命周期。
2. 保留现有工作区的 `.dsh/work-evidence/config.json` 和会话策略文件；升级前另存一份 `config.json`，以便回退时恢复原始设置。1.1.0 会读取已有 JSON，不要求重建。
3. 用 1.1.0 发布包替换插件目录。
4. 重启宿主，先用 `/work-evidence status` 和 `/work-evidence features` 查看配置、依赖和有效状态。
5. 确认 `dependencies.archiveDecoder.available` 为 `true`。仅确认 `fflate` 包可安装不够；插件或宿主无法实际加载解码器时，归档读取仍会返回 `ARCHIVE_DECODER_UNAVAILABLE`。
6. 需要完整工具面时显式执行 `/work-evidence feature toolSurface full`；默认仍为 compact。

## 配置行为

- `qualityReview`、`completionNotice`、`requestProjection`、`projectionRestore`、`swLedger`、`swEviction`、`deferPressureCompaction`、`stubSummary`、`structuredCalls`、`nativeProgramReuse`、`nativeReasoningReplay` 和 `finalJsonResultGuard` 默认关闭。需要阶段摘要后的自动继续时，显式开启 `completionNotice`。升级前已显式写入 `completionNotice: true` 的工作区会保留该值；用 `/work-evidence feature completionNotice` 查看当前配置，用 `/work-evidence feature completionNotice off` 关闭。
- `contextPruningPolicy` 只接受 `forecast`；`compactionTiming` 只接受 `native`；旧值会安全归一到这两个有效值。
- `mode` 不再设置运行模式。Ultra 使用质量模式，非 Ultra 在 `aggressiveMode` 开启时使用激进模式。
- 旧布尔设置 `programHistory`、`reasoningHistory`、`ledgerFoldPlan`、`ledgerFoldWrite`、`executionAdvice`、`finishAdvice`、`taskEffort`、`nativeReadView`、`nativeExecutionEvidence`、`cacheOrderedStub` 和 `archiveEntries` 保留读取兼容并固定为关闭，不会重新接线。
- `DSH_EXPERIMENT_DEFER_COMPACTION`、`DSH_EXPERIMENT_STUB_SUMMARY` 和 `DSH_EXPERIMENT_STUB_DEDUP` 不再是稳定行为开关；请使用显式工作区设置或代码选项。

## 依赖与宿主

发布声明只包含实际验证的宿主版本。若使用的宿主不在声明范围，先不要启用插件自动处理；记录版本并完成对应宿主验证后再升级声明。`fflate 0.8.3` 的归档行为已按发布依赖验证，宿主内其他 `fflate` 版本不能替代该证据。

## 验收后

升级后运行 `npm run check`、仓库 Node 测试和双宿主关键路径检查。任何失败保留原错误和来源，不删除测试或降低断言。完成后按 [范围冻结](1.1.0-SCOPE-FREEZE.md) 记录同一候选 SHA 的结果。
