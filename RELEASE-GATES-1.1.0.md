# Work Evidence 1.1.0 发布门禁

版本：`1.1.0`

模式策略：`pb001-v39`

本文件随最终候选提交发布。候选身份以包含本文件的提交为准；测试日志记录该提交的完整 SHA。不得用较早提交的结果替代最终候选验收。执行类 Gate 与 G6 的最终状态由同一候选 SHA 的验收、审查台账记录，不在提交内预写通过。

## Gate 状态

| Gate | 条件 | 当前证据 | 状态 |
|---|---|---|---|
| G0 范围闭环 | 正式功能全部成熟采用或正式淘汰 | 38 个入口已有定义，但逐项真实触发、组合路径、释放、迁移、文档和淘汰闭环尚未完成 | 待功能终审 |
| G1 正确性 | 全量功能、异常和恢复测试通过；无已知 P0/P1 阻塞逻辑错误 | 归档、轨迹、REV、生命周期和发布检查均有复现测试；最终结果以同一候选 SHA 的双宿主全量日志为准 | 待同 SHA 验收台账确认 |
| G2 全功能成熟 | 保留入口、模式、启停、恢复、迁移和错误返回与文档一致 | 现有文档和测试覆盖部分入口；逐项成熟度和实际组合路径尚未完成 | 待功能终审 |
| G3 效率 | 默认在线开销有证据；重大负优化已处理；收益不夸大 | 旧实验使用了其他路由/档位且没有开发/留出 B0/C；H1–H7 新口径实验尚未完成 | 待新版实验 |
| G4 宿主与集成 | 两个声明宿主关键路径通过，声明与实测一致 | `0.2.1-rc.4` 与 `0.2.2-rc.1` 使用隔离工作区和 `fflate 0.8.3`；最终结果以同一候选 SHA 的双宿主全量日志为准，日志首行记录实测宿主版本 | 待同 SHA 验收台账确认 |
| G5 安全与可靠性 | 无已知 P0/P1 漏洞、越权或状态破坏；故障注入通过 | 路径、归档、非法参数、乱序、重复结果、未结束写入、共享读取取消和资源释放均有测试；最终结果以同一候选 SHA 的全量日志为准 | 待同 SHA 验收台账确认 |
| G6 CodeRabbit | 核心 PR 至少三轮有效审查，最终候选与集成复审覆盖 | `coderabbit-review-ledger.md` 已重建三轮正式 Review 和线程处置；跳过文件不计实质复核，最终候选若继续改动需重新评估 | 待同 SHA 终审确认 |
| G7 实验可信 | 代表试验与离线基线可复现，用量和 `unknown` 口径真实 | 旧实验明确不是新版 B0/C；新模型、独立开发/留出和 H1–H7 原始轨迹尚未完成 | 待新版实验 |
| G8 构建与文档 | 安装包、依赖、版本、README、迁移、Release Notes 和回退指南一致 | 发布清单、`npm run check`、`npm pack` 与独立安装加载结果以同一候选 SHA 的验收台账为准 | 待同 SHA 验收台账确认 |
| G9 最终统一回归 | 从最终候选 SHA 重跑全套关口 | 对包含本表的最终候选提交执行双宿主全量、发布检查和独立安装；结果见同一候选 SHA 的验收台账 | 待同 SHA 验收台账确认 |

## 证据定位

- 运行日志、打包清单和独立加载结果保存在本地交付目录 `outputs/work-evidence-1.1.0/`。日志首行记录候选完整 Commit SHA、宿主版本、命令和开始时间。该目录中的同 SHA 验收台账确认 G1、G4、G5、G8、G9 后，这些 Gate 才通过；无需为回填状态再改本文件。
- 审查轮次、reviewed SHA、issue 处置和跳过记录见同目录 `coderabbit-review-ledger.md`；PR 描述记录最新正式 review。该台账确认最终候选的本文件已实际审阅且真实问题已处理后，G6 才通过；无需为回填状态再改本文件。
- 私人原始会话、事件正文、真实账单和本机绝对路径不进入公开仓库。

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

G4 完成前必须同时保留两次运行各自的宿主版本与结果记录。宿主版本取自该宿主 `node_modules/@deepseek-ai/dsh-tools/package.json`，不是 `DSH_APP` 自身的 `package.json`（保存宿主的该文件没有 version 字段）。两次记录的版本相同时，不算覆盖两个受支持版本，必须换用另一版本重跑其中一次。

发布包：

```powershell
npm run check
npm pack --json
```

在临时目录安装 tarball 后加载 `index.mjs`，核对 `feature-control.mjs` 的 38 个入口、版本、`fflate 0.8.3` 和发布文件清单。

## 已知非阻塞限制

- 归档解码在内存中完成，未实现流式解压。归档文件上限为 128 MiB；普通文本条目解压后上限为 8 MiB；`META-INF/MANIFEST.MF` 和 Maven `pom.properties` 的解析上限为 64 KiB。
- 验证环境为 Windows 和 Node.js 22.19；其他平台不做未经验证的声明。
- 真实账单、网关内部重试和底层模型权重不可见。
- 历史轨迹来自旧版本和旧通道，没有独立留出集，不支持普遍精确率、召回率或 Token 收益结论。
- CodeRabbit 文档注释覆盖率警告不是功能正确性证明；未真实覆盖的审查轮次不得计入 G6。

## 发布状态

本版本只有在 G0–G9 全部对同一候选通过后才能标记为稳定 `1.1.0`。远端合并和正式发布仍由仓库治理权限决定。
