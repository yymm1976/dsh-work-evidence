# Work Evidence 1.1.1 发布门禁

版本：`1.1.1`

模式策略：`pb001-v39`

候选代码：`a8f0bf1`（v7 候选，24 题 C 组实测所用提交）
发布文档提交：`bf88151` 及后续文档更正提交
分支：`feat/work-evidence-1.1.1-efficiency`（已推送 GitHub）

本文件只记录本分支真实执行过的检查。不得用 1.1.0 的候选 `2f398e0`、`619/619`、`+23.19%`、CodeRabbit 13 轮或 1.1.0 的 tag/Release 作为 1.1.1 的证据。

## Gate 状态

| Gate | 条件 | 本分支真实证据 | 状态 |
|---|---|---|---|
| G0 范围闭环 | 正式功能全部成熟采用或正式淘汰 | `feature-control.mjs` 38 个入口与 `FEATURE-CONTROL-MATRIX-1.1.1.md` 38 行一一对应（程序比对无缺项、无多项） | 通过 |
| G1 正确性 | 全量功能与恢复测试通过，fail=0、skipped=0 | 最终候选 `a5bd224` 上隔离 profile 双宿主 `node --test`：**各 621 项，621 pass / 0 fail / 0 skipped，exit 0**（`results/full-test-final3-022.log`、`results/full-test-final3-021.log`）；桌面默认 profile 的 ACP 导出错误改用实验隔离 profile 后消失 | 通过 |
| G2 全功能成熟 | 入口、启停、恢复、迁移与文档一致 | `test/release-metadata.test.mjs`、`test/package-install.test.mjs` 在版本 bump 后 2/2 通过；`MIGRATION-1.1.1.md`、`ROLLBACK-1.1.1.md`、`RELEASE-NOTES-1.1.1.md` 已提交 | 通过（文档一致性） |
| G3 效率 | 固定任务上有可复算的真实收益 | `experiments/1.1.1b/FINAL-METRICS-1.1.1b.json`（`a5bd224`）：24 对，B0 `$0.762347544` → C `$0.411753138`，总体 **+45.99%**；逐题均值 39.14%、中位数 **49.06%**；**21/24 题节省**，3 题增加（#8 -109.0%、#18 -7.6%、#19 -11.1%，均单列）。请求 834/567、输出 589,450/382,413、输入 1,980,924/908,919、缓存 37,179,648/15,322,496、工具 1,344/835、墙钟 12,906/7,877 s。机制触发：测试回执与通用工具回执均 **0/24**。稳定性：同运行时重复三个负向任务全部转正（#8 +2.3%、#18 +9.2%、#19 +3.6%），原样本保留 | 通过 |
| G4 宿主与集成 | 两个声明宿主通过 | `0.2.2-rc.1`：621/621（`full-test-final3-022.log`）；`0.2.1-rc.4`：621/621（`full-test-final3-021.log`），均 fail 0、skipped 0、exit 0 | 通过 |
| G5 安全与可靠性 | 无 P0/P1 漏洞，故障注入通过 | 621 项通过项覆盖归档、路径、生命周期、清理竞态与故障注入；未发现本插件 P0/P1 | 通过 |
| G6 CodeRabbit | 至少三轮有效审查覆盖最终变更 | PR #9（<https://github.com/yymm1976/dsh-work-evidence/pull/9>）完成 **5 轮**实质审查（7+9+4+2+1 条）。第 1–4 轮意见全部修复并推送；第 5 轮唯一意见被 CodeRabbit 标为 Unverified，已在 PR 评论记录拒绝理由（删除仅适用于测试自身错误，正确的失败复现须保留至修复或报告受阻）。≥3 轮条件满足 | 通过 |
| G7 实验可信 | 路由、样本与口径可信 | 24 对共 48 单元全部 `opencode-go/deepseek-v4.1-flash`、`reasoning_effort=max`、`identityValid=true`；C 单元协议记录 `sourceCommit=a5bd224`；B0 干净重建；污染/TRANSPORT 无效样本归档于 `archive/` | 通过 |
| G8 构建与文档 | 包、依赖、版本与文档一致 | `a5bd224`：`npm run check` **145 个 JS 文件**通过；`npm pack` 82 文件、**426,948 字节**、SHA-1 `5a195b53482bce706deea5c1a575e4813d864741`（sha256 `0270231b…`）；`verification-1.1.1/install-final-v13` 独立安装成功，版本 1.1.1，唯一依赖 `fflate ^0.8.3`，挂载宿主 peer 后入口加载成功 | 通过 |
| G9 最终统一回归 | 从最终候选重跑全套关口 | `a5bd224` 上完成 `npm run check`、双宿主 621/621、`npm pack`、独立安装与加载；效率汇总使用同一提交的 24 题 C | 通过（G6 已满足） |

## 证据定位

- 原始会话、48 个单元结果、Patch、测试日志、协议/有效性文件、24 份评分与复算工具：私有证据仓库 `dsh-work-evidence-24task-evidence` 提交 `1c28acd`（`1.1.1/` 目录，280 个文件）；最终报告、独立复审、v8 否决样本、稳定性重复与双宿主最终日志在提交 `db63337` 及后续提交。
- 汇总复算：`experiments/1.1.1/FINAL-METRICS-1.1.1.json`、`scores.json`、`quality-summary.json`、`evidence-index.json`。
- 全量测试日志：`results/full-test-final2-022.log`（0.2.2，620/620）、`results/full-test-final2-021.log`（0.2.1，620/620）；`full-test-111.log` 为默认 profile 的 617/620 记录，`full-test-111-acp.log`/`full-test-111-host-021.log`/`full-test-final-*` 为同运行时中间轮次，均保留作环境对照。
- 打包与安装：`verification-1.1.1/`（最终工件摘要见 G8）；该目录只在本机交付证据中，不进入公开仓库。
- 私人原始会话、真实账单和本机绝对路径不进入公开仓库。

## L0–L5 门禁

| 层级 | 已执行内容 | 证据 |
|---|---|---|
| L0 快速 | 全部仓库 JavaScript 语法检查、版本与配置一致性、`git diff --check` | `npm run check`（145 文件）、`test/release-metadata.test.mjs` |
| L1 单元 | 模块、状态机、配置、路径、失败边界和证据失效规则 | `test/` 下的单元与回归测试（621 项通过） |
| L2 全量 | 全部 Node 测试、功能交互、历史兼容和实验工具链 | `node --test`（621/621，fail=0，skipped=0） |
| L3 宿主 | 桌面宿主加载、原生工具、PTC、模式、生命周期和组合路径 | `0.2.2-rc.1` 与 `0.2.1-rc.4` 各 621/621（隔离 profile） |
| L4 发布 | 独立安装、文件清单、打包、版本、文档和插件加载 | `verification-1.1.1/` 的 pack 与独立安装记录 |
| L5 可靠性 | 归档故障注入、并发、路径安全、性能和长会话边界 | `test/evidence-archive.test.mjs`、轨迹重放和相关宿主测试 |

## 已知非阻塞限制

- 归档解码在内存中完成，未实现流式解压。归档文件上限为 128 MiB；普通文本条目解压后上限为 8 MiB；`META-INF/MANIFEST.MF` 和 Maven `pom.properties` 的解析上限为 64 KiB。
- 验证环境为 Windows 和 Node.js 22.19；其他平台不做未经验证的声明。
- 真实账单、网关内部重试和底层模型权重不可见。
- 24 题质量评分为主 Agent 非盲评（插件回执会暴露身份），#6 标记争议；不得称为官方 benchmark 解决率。
- 测试输出回执是请求视图，不改变规范事件。
- 3 项 ACP 集成测试受外部包版本影响；插件运行时未修改该包。

## 发布状态

**`v1.1.1` 未发布。**

- 远端 main：`7840220`（1.1.0 文档补正 PR #8 合并提交）。
- 远端 tag `v1.1.0`：annotated `07e1488`，指向 `7a049c5`；GitHub Release `439385235` 属于 **1.1.0**，不是 1.1.1。
- 不存在 tag `v1.1.1`，不存在对应 Release。
- 合并与正式 Release 由用户决定；本分支只提供发布候选与验收记录。
