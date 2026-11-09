# Work Evidence 1.1.0 发布门禁

版本：`1.1.0`

模式策略：`pb001-v39`

本文件随最终候选提交发布。候选身份以 Git 提交完整 SHA 为准，并由同目录证据台账记录；不得用较早提交的结果替代最终候选验收。执行类 Gate 与 G6 的最终状态由同一候选 SHA 的验收、审查台账记录，不在提交内预写通过。

## Gate 状态

| Gate | 条件 | 最终证据（验收候选 `2f398e0`） | 状态 |
|---|---|---|---|
| G0 范围闭环 | 正式功能全部成熟采用或正式淘汰 | `FEATURE-CONTROL-MATRIX-1.1.0.md` 38 行与 `feature-control.mjs` 38 个入口一一对应；`completionNotice` 默认关闭；在线 EGC 与独立候选系统否决；矩阵 11 处按代码更正 | 通过 |
| G1 正确性 | 全量功能与恢复测试通过 | 双宿主 `node --test` 各 619/619，fail 0，skipped 0，exit 0（`verification/node-test-rc{4,1}-2f398e0.log`） | 通过 |
| G2 全功能成熟 | 入口、启停、恢复、迁移与文档一致 | 38 个入口矩阵、迁移含依赖与 FastEdit 环境、回退步骤保留、README 正式路由 `max`；`RELEASE-NOTES-1.1.0.md` 描述实际行为 | 通过 |
| G3 效率 | 默认路径有证据，收益不夸大 | `results/FINAL-METRICS-1.1.0.json`：四组加权 **+23.19%**（≥10%）；剔除零触发组后三个真实触发组 **+23.06%**；三类项目 dev/holdout 方向均不反转 | 通过 |
| G4 宿主与集成 | 两个声明宿主通过 | `0.2.1-rc.4` 与 `0.2.2-rc.1` 各 619/619，日志首行记录实测版本 | 通过 |
| G5 安全与可靠性 | 无 P0/P1 漏洞，故障注入通过 | 归档、路径、生命周期、清理竞态（`disposal-coordinator.test.mjs`）回归全绿 | 通过 |
| G6 CodeRabbit | 至少三轮实质审查并覆盖最终变更 | 13 轮请求，第 6–12 轮入账；此前 49 个审查线程已 resolved。最终审查 `5829155540`（`2f398e0`，发布前 3 分钟）提出 4 条文档问题，发布后由 PR #8 修复，无代码问题 | 通过（发布后补正） |
| G7 实验可信 | 路由、样本与口径可信 | 全部正式单元 `effort=max`、`identityValid=true`；B0 固定 `4978b31`；8 个环境无效单元按预注册作废并替换（7 C + 1 B0） | 通过 |
| G8 构建与文档 | 包、依赖、版本与文档一致 | `check` 144 文件；`pack` 82 文件，`shasum`/`integrity` 与工件一致；独立安装/加载通过 | 通过 |
| G9 最终统一回归 | 从最终候选重跑全套关口 | 同一 `2f398e0` 完成双宿主、check、pack、install、效率汇总 | 通过 |

## 证据定位

- 运行日志、打包清单和独立加载结果保存在本地交付证据目录。日志首行记录候选完整 Commit SHA、宿主版本、命令和开始时间；末行记录退出码和结束时间。
- 审查轮次、reviewed SHA、意见处置和跳过记录见 [CodeRabbit 台账](coderabbit-review-ledger.md)。该台账确认最终候选的本文件已实际审阅且真实问题已处理后，G6 才通过。
- 私人原始会话、事件正文、真实账单和本机绝对路径不进入公开仓库。
- 宿主验收要求 `skipped=0`：若 profile 缺少 OPS 或 FastEdit Python 路径缺失，相关测试会跳过，`node --test` 仍可能以 0 退出；这类运行不得记为 G1/G4 通过。验收前必须准备隔离 profile 与 `DSH_TEST_FASTEDIT_PYTHON`，并核对日志中的 skipped 计数。

## L0–L5 门禁

| 层级 | 已执行内容 | 证据 |
|---|---|---|
| L0 快速 | 全部仓库 JavaScript 语法检查、版本与配置一致性、`git diff --check` | `npm run check`、`test/release-syntax.test.mjs`、`test/release-metadata.test.mjs` |
| L1 单元 | 模块、状态机、配置、路径、失败边界和证据失效规则 | `test/` 下的单元与回归测试 |
| L2 全量 | 全部 Node 测试、功能交互、历史兼容和实验工具链 | `node --test` |
| L3 宿主 | 双宿主加载、原生工具、PTC、模式、生命周期和组合路径 | 隔离宿主工作区的完整 `node --test` |
| L4 发布 | 独立安装、文件清单、打包、版本、文档和插件加载 | `npm pack --json` 后的临时目录安装与加载 |
| L5 可靠性 | 归档故障注入、并发、路径安全、性能和长会话边界 | `test/evidence-archive.test.mjs`、轨迹重放和相关宿主测试 |

## 最终验收命令

以下路径均为占位符。运行前必须把 `DSH_APP`、`DSH_PROFILE`、`DSH_TEST_FASTEDIT_PYTHON` 和 `DSH_TEST_PYTHON` 换成待验收环境的实际路径。

保存宿主：

```powershell
$env:DSH_APP='<saved-host-0.2.1-rc.4>'
$env:DSH_PROFILE='<dsh-profile>'
$env:DSH_TEST_FASTEDIT_PYTHON='<candidate-checkout>/.fastedit-venv/Scripts/python.exe'
$env:DSH_TEST_PYTHON='<test-python-3.12>'
(Get-Content "$env:DSH_APP/node_modules/@deepseek-ai/dsh-tools/package.json" -Raw | ConvertFrom-Json).version
node --test
```

桌面宿主：

```powershell
$env:DSH_APP='<desktop-host-0.2.2-rc.1>'
$env:DSH_PROFILE='<dsh-profile>'
$env:DSH_TEST_FASTEDIT_PYTHON='<candidate-checkout>/.fastedit-venv/Scripts/python.exe'
$env:DSH_TEST_PYTHON='<test-python-3.12>'
(Get-Content "$env:DSH_APP/node_modules/@deepseek-ai/dsh-tools/package.json" -Raw | ConvertFrom-Json).version
node --test
```

G4 完成前必须同时保留两次运行各自的宿主版本与结果记录，并确认两次日志均为 `fail=0`、`skipped=0`。宿主版本取自该宿主 `node_modules/@deepseek-ai/dsh-tools/package.json`，不是 `DSH_APP` 自身的 `package.json`（保存宿主的该文件没有 version 字段）。两次记录的版本相同时，不算覆盖两个受支持版本，必须换用另一版本重跑其中一次。

发布包：

```powershell
npm run check
npm pack --json
```

在临时目录安装 tarball 后加载 `index.mjs`，核对 `feature-control.mjs` 的 38 个入口、版本、`fflate 0.8.3` 和发布文件清单。发布包不含 `node_modules`，独立安装必须先安装 `fflate 0.8.3` 或由宿主提供。

## 已知非阻塞限制

- 归档解码在内存中完成，未实现流式解压。归档文件上限为 128 MiB；普通文本条目解压后上限为 8 MiB；`META-INF/MANIFEST.MF` 和 Maven `pom.properties` 的解析上限为 64 KiB。
- 验证环境为 Windows 和 Node.js 22.19；其他平台不做未经验证的声明。
- 真实账单、网关内部重试和底层模型权重不可见。
- 历史轨迹来自旧版本和旧通道，没有独立留出集，不支持普遍精确率、召回率或 Token 收益结论。
- CodeRabbit 文档注释覆盖率警告不是功能正确性证明；未真实覆盖的审查轮次不得计入 G6。
- 测试输出回执是请求视图，不改变规范事件；`node --test` 只对带完整 TAP 摘要的输出生成回执。
- 单次任务失败与插件机制无因果关系时，按实验装配或任务难度单独登记，不并入插件质量结论。

## 发布状态

`v1.1.0` 已发布：tag `v1.1.0`（annotated `07e1488…`）→ `main` 合并提交 `7a049c5`；验收候选 `2f398e0` 与之运行时逐字节一致。

- Release `439385235`：<https://github.com/yymm1976/dsh-work-evidence/releases/tag/v1.1.0>，非 draft、非 prerelease。
- 工件 `local-dsh-work-evidence-1.1.0.tgz`，423,740 字节，sha256 `c79524a2…`，与 GitHub 记录 digest 一致。
- 发布后独立安装并以 `0.2.2-rc.1` 宿主加载通过（`verification/post-release-install.log`）。

本表此前记录的是发布前检查状态；发布后已在 `main` 同步为最终证据。最终结论以 `verification/ACCEPTANCE-2f398e0.md` 与 `verification/FINAL-REPORT-1.1.0.md` 为准。
