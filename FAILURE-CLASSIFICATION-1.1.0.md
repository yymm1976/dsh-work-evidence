# 1.1.0 失败日志分类

范围：候选 `4978b31d017412214319bcd4ae8fa889492ed9fa`。三份早期 rc4 日志保留原始文件，后续 `592 pass / 0 fail` 日志只作为修复后的环境证据，不覆盖失败事实。

| 日志 | 结果 | 共同根因 | 源码判断 | 分类与处置证据 |
|---|---:|---|---|---|
| `node-test-0.2.1-rc.4-4978b31.log` | 395 pass / 197 fail | 首个高频错误是 `MODULE_NOT_FOUND: @deepseek-ai/dsh-session-query`，随后同一缺失宿主依赖级联 | 未形成独立源码缺陷；失败发生在测试装载/模块解析阶段 | 隔离宿主装配问题；补齐对应宿主包后进入下一轮 |
| `node-test-0.2.1-rc.4-4978b31-rerun.log` | 549 pass / 43 fail | 仍缺 `dsh-agent-tool-presentation`、`dsh-compaction-basic`、`dsh-tool-jobs`、`dsh-subagent-spawn-in-process`、`dsh-session-query-sqlite`、`dsh-tool-session-query`、`dsh-llm-pi-ai` | 仍不是 43 个独立源码错误；栈顶是 require 失败 | 隔离宿主/profile 装配差异；按 rc4 宿主补装并重新建立独立 profile |
| `node-test-0.2.1-rc.4-4978b31-final.log` | 559 pass / 33 fail | 缺失依赖减少后暴露 `Cannot find the native Koffi module`、默认路径状态不一致、Java parser 运行时不可用、package readiness 为 `blocked` | Koffi、FastEdit/Python、profile readiness 是环境/配置问题；parser 测试暴露的是运行时能力缺失，不是 Java 业务实现错误 | 隔离原生依赖、FastEdit Python 和 profile 状态分别修复；最终 rc4 日志 `592/0` 复验 |

补充判断：Java fallback 的 `lexical` 结果和测试预期 `tree-sitter` 不一致，根因是 FastEdit/bridge 能力未在该宿主隔离环境装配；不应修改源码把降级结果伪装成 tree-sitter。`default-path-consistency` 的两项失败来自测试用 profile 未达到默认工作状态，随后同一候选在修复后的隔离状态通过。`package readiness` 的 `blocked` 来自缺依赖/状态条件，不代表功能永久不可用。

修复后证据：

日志目录：`C:/Users/杨铭/Documents/Codex/2026-11-08/`。下表按时间顺序保留每一轮的真实结果，失败轮不计入通过。

| 轮次（日志后缀） | rc4 结果 | rc1 结果 | 根因与处置 |
|---|---|---|---|
| `isolated-python-final` | 592 pass / 0 fail / 0 skipped | 591 pass / 1 fail / 0 skipped | rc1 唯一失败 `native-reasoning-replay`：候选 `node_modules/@deepseek-ai` junction 指向 rc4，两版 `dsh-llm` 的私有 `WeakSet` 实例分裂，`isAgentLoopRequest(result.options)` 返回 false。属测试装配/测试契约问题，不是产品 builder 逻辑缺陷 |
| `hostresolved` | 576 pass / 9 fail / 7 skipped | 576 pass / 9 fail / 7 skipped | 整体移出 `@deepseek-ai` 目录导致 9 项依赖闭包失败；方案废弃 |
| `hostresolved2` | 575 pass / 10 fail / 7 skipped | 575 pass / 10 fail / 7 skipped | `DSH_PROFILE` 指向不存在的候选 profile，10 项依赖级联失败；方案废弃，不计入双宿主通过 |
| `hostresolved3` | 390 pass / 199 fail（589 tests） | 390 pass / 199 fail（589 tests） | 把所有 `@deepseek-ai/*` 强制改成 file URL，破坏宿主 CJS 内部 `require`；方案废弃 |
| `hostresolved4` | 591 pass / 1 fail / 0 skipped | 591 pass / 1 fail / 0 skipped | 只重定向 `dsh-llm`；剩余失败在 `experiment-consumption.test.mjs:108`，CJS `require` 再次经过 ESM hook 报 `MODULE_NOT_FOUND` |
| `hostresolved5` | 592 pass / 0 fail / 0 skipped，退出码 0，duration_ms 176258.7 | 592 pass / 0 fail / 0 skipped，退出码 0，duration_ms 166315.8 | hook 增加 `!context.conditions?.includes('require')` 条件后双宿主全量通过；此前轮次的 7 项 skipped 不再存在 |

`hostresolved5` 两份日志第 1 行记录 `candidate=4978b31d017412214319bcd4ae8fa889492ed9fa`、host 版本、`node=v22.19.0`、`DSH_APP`、`DSH_PROFILE`、`DSH_TEST_FASTEDIT_PYTHON`、`DSH_TEST_PYTHON`、`DSH_HOME` 的隔离路径。该结果基于工作树（`4978b31` 加未提交的 `test/helpers/host.mjs` 修复）；发布前必须把修复提交到最终 SHA 并复验。hook 只重定向 `dsh-llm`，其余 `@deepseek-ai` 包的同源解析依赖候选 `node_modules` 装配，当前证据是双宿主全量通过本身。

分类结论：上述失败均为隔离测试装配、环境配置或测试契约问题，不构成独立产品源码缺陷，也不构成 `EXTERNAL_BLOCKED`。剩余工作是新模型口径实验、功能成熟度终审和发布门禁，均属未完成工程工作。
