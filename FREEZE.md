# 冻结声明（0.28.10）

**冻结日期**：2026-10-31
**版本**：0.28.10
**模式策略**：pb001-v23（兼容 pb001-v1 至 pb001-v22 旧记录）
**冻结范围**：`package.json` 的 `files` 清单所列全部文件（源码 `.mjs`、Python 桥、`locale/`、`icon.svg`、`cordis.patch.yml`、`README.md`），加上 `package.json` 自身、本文件 `FREEZE.md` 与校验脚本 `verify-freeze.mjs`，共 61 项，逐文件 SHA-256 见同目录 `FREEZE.sha256`。`engineering/*.json` 等运行产物与备份目录不在冻结范围。冻结后不再修改，除非有新预注册实验或致命缺陷修复。

## 冻结时的状态

- 质量档提示词：用户提供的英文护栏原文（UNLIMITED TOKEN BUDGET + 六条原则 + Completion Discipline），已删除 cp031 判定无效的 v22 条款、中文定向段与"旧能力包装"规则。
- 压缩机制：stub 摘要、缓存友好前缀、归档三个开关默认关闭，需环境变量显式开启（`DSH_EXPERIMENT_STUB_SUMMARY` / `DSH_EXPERIMENT_CACHE_ORDERED_STUB` / `DSH_EXPERIMENT_ARCHIVE_ENTRIES`）。块内去重 `dedupLongSegments` **默认开启**（`context-pruning.mjs` 的判据是 `options.dedupSegments !== false && DSH_EXPERIMENT_STUB_DEDUP !== '0'`），仅在单条结果超过 8K 字符、且内部出现 ≥2048 字符重复段时触发；LP014 显示 stub+dedup 组合费用劣于单 stub，是否长期保留待观察。
- 默认与激进档说明未改动。
- 2026-10-31 冻结后只做过"打包补强"：新增 `verify-freeze.mjs`、`package.json` 的 `scripts`（`verify` / `check`）、`FREEZE.sha256` 扩至 61 项、`FREEZE.md` 与 `README.md` 的文档修正。**未改动任何运行时 `.mjs`**，因此版本号保持 0.28.10、策略版本保持 pb001-v23。这样做是为了让 cp032 / cp032b 实验钉住的 `pluginVersion=0.28.10` 与仓库代码始终一致；若此时升版本，实验记录会跨版本混用。

## 完整性清单（SHA-256）

完整清单在 `FREEZE.sha256`（61 行，格式 `hash  path`）。校验：

```bash
node verify-freeze.mjs
```

该脚本跨平台，不依赖 `sha256sum`；任何文件被改动或缺失都会以非零退出码报告。

## 校验方法

```bash
cd <插件目录>
node verify-freeze.mjs
node --check runtime.mjs && node --check task-flow.mjs
node -e "import('./task-flow.mjs').then(m=>console.log(m.taskFlowGuidance('quality','writable').length))"
```

## 备份

- `dsh-work-evidence-backup-0.28.9-20261031`（0.28.9 冻结前快照，v22 提示词）
- `dsh-work-evidence-backup-0.28.8-20261031`（0.28.8 冻结版）

## 解冻规则

1. 任何提示词或行为改动必须先写预注册设计稿（判据、格数、预算、停止条件）。
2. 实验必须钉住 `pluginVersion` 与 `policyVersion`，不得混用版本比较。
3. 解冻后版本号递增，并在 README 变更记录登记；不得原地改冻结版本。
