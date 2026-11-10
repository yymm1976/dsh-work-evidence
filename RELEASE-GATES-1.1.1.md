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
| G1 正确性 | 全量功能与恢复测试通过，fail=0、skipped=0 | `full-test-111.log`：620 项，**617 pass / 3 fail / 0 skipped**；3 项均为 `test/host-acp.test.mjs` 与 `test/host-acp-combinations.test.mjs` 导入已安装的 `billion-context-dsh@0.2.26` 时，宿主 `@deepseek-ai/dsh-llm@0.2.2-rc.1` 不提供该包请求的 `CallId` 导出（宿主实际导出为 `ToolCallId`）。其余 617 项通过 | **未通过**（外部 ACP 版本不兼容，非插件逻辑失败；fail=0 未满足） |
| G2 全功能成熟 | 入口、启停、恢复、迁移与文档一致 | `test/release-metadata.test.mjs`、`test/package-install.test.mjs` 在版本 bump 后 2/2 通过；`MIGRATION-1.1.1.md`、`ROLLBACK-1.1.1.md`、`RELEASE-NOTES-1.1.1.md` 已提交 | 通过（文档一致性） |
| G3 效率 | 固定任务上有可复算的真实收益 | `experiments/1.1.1/FINAL-METRICS-1.1.1.json`：24 对，B0 `$0.762347544` → C `$0.424497282`，总体 **+44.317%**；逐题均值 42.044%、中位数 47.700%；**23/24 题节省**；#8 为 **-81.1%** 单列。请求 834/542、输出 589,450/389,643、输入 1,980,924/959,031、缓存 37,179,648/15,618,944、工具 1,344/822、墙钟 12,906/7,730 s | 通过（>30% 目标；#8 负结果完整披露） |
| G4 宿主与集成 | 两个声明宿主通过 | 已实测 `0.2.2-rc.1`（617/620，3 项外部 ACP 失败）；`0.2.1-rc.4` 保存宿主在本机目录不完整（`node_modules/@deepseek-ai` 缺失），本分支未完成第二宿主全量测试 | **未完成**（第二宿主待可用环境） |
| G5 安全与可靠性 | 无 P0/P1 漏洞，故障注入通过 | 617 项通过项覆盖归档、路径、生命周期、清理竞态与故障注入；3 项外部 ACP 失败不涉及本插件路径 | 通过（以已通过项为限） |
| G6 CodeRabbit | 至少三轮有效审查覆盖最终变更 | 本分支尚无 PR、无 CodeRabbit 审查记录；仓库历史 13 轮审查均针对 1.1.0 候选 `2f398e0`。本机无 `gh` CLI，浏览器会话未登录 GitHub，PR 创建被外部认证阻断 | **未通过**（不得以历史轮次冒充） |
| G7 实验可信 | 路由、样本与口径可信 | 24 对共 48 单元全部 `opencode-go/deepseek-v4.1-flash`、`reasoning_effort=max`、`identityValid=true`；C 单元协议记录 `sourceCommit=a8f0bf1`；B0 干净重建；污染/TRANSPORT 无效样本归档于 `archive/` | 通过 |
| G8 构建与文档 | 包、依赖、版本与文档一致 | `npm run check` 146 个 JS 文件通过；`npm pack` 82 文件、426,167 字节、SHA-1 `d4ebd05f71e4153cebfa9461ef4faed364a95e88`；`tmp/install-111` 独立安装成功，版本 1.1.1，唯一依赖 `fflate ^0.8.3`，入口可加载 | 通过 |
| G9 最终统一回归 | 从最终候选重跑全套关口 | 文档更正后尚未冻结最终文档提交并重跑 G1/G4/G8 | **未执行** |

## 证据定位

- 原始会话、48 个单元结果、Patch、测试日志、协议/有效性文件、24 份评分与复算工具：私有证据仓库 `dsh-work-evidence-24task-evidence` 提交 `1c28acd`（`1.1.1/` 目录，280 个文件）。
- 汇总复算：`experiments/1.1.1/FINAL-METRICS-1.1.1.json`、`scores.json`、`quality-summary.json`、`evidence-index.json`。
- 全量测试日志：`results/full-test-111.log`（620 项，617 pass / 3 fail / 0 skip）。
- 打包与安装：`tmp/local-dsh-work-evidence-1.1.1.tgz`、`tmp/install-111/`。
- 私人原始会话、真实账单和本机绝对路径不进入公开仓库。

## L0–L5 门禁

| 层级 | 已执行内容 | 证据 |
|---|---|---|
| L0 快速 | 全部仓库 JavaScript 语法检查、版本与配置一致性、`git diff --check` | `npm run check`（146 文件）、`test/release-metadata.test.mjs` |
| L1 单元 | 模块、状态机、配置、路径、失败边界和证据失效规则 | `test/` 下的单元与回归测试（617 项通过） |
| L2 全量 | 全部 Node 测试、功能交互、历史兼容和实验工具链 | `node --test`（617/620） |
| L3 宿主 | 桌面宿主加载、原生工具、PTC、模式、生命周期和组合路径 | `DSH_APP=0.2.2-rc.1` 的全量测试；第二宿主未完成 |
| L4 发布 | 独立安装、文件清单、打包、版本、文档和插件加载 | `npm pack` + `tmp/install-111` |
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
