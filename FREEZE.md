# 冻结声明（0.28.10）

**冻结日期**：2026-10-31
**版本**：0.28.10
**模式策略**：pb001-v23（兼容 pb001-v1 至 pb001-v22 旧记录）
**冻结范围**：本目录全部源码与配置。冻结后不再修改，除非有新预注册实验或致命缺陷修复。

## 冻结时的状态

- 质量档提示词：用户提供的英文护栏原文（UNLIMITED TOKEN BUDGET + 六条原则 + Completion Discipline），已删除 cp031 判定无效的 v22 条款、中文定向段与"旧能力包装"规则。
- 压缩机制：0.28.9 并入的 stub 摘要、块内去重、缓存友好前缀/归档开关，全部带 feature flag，默认关闭（`DSH_EXPERIMENT_STUB_SUMMARY` / `DSH_EXPERIMENT_STUB_DEDUP` / `DSH_EXPERIMENT_CACHE_ORDERED_STUB` / `DSH_EXPERIMENT_ARCHIVE_ENTRIES`）。
- 默认与激进档说明未改动。

## 完整性清单（SHA-256）

```
c2dfdd4c805fdfc3829bffbe6a6a3d0e3aaa419fe03ae1f7ff26f7c9dfcce434  package.json
b2578f29c8053275384bd2607399dc7a7bfebf1e5ad92269f3048932cb3ab45c  runtime.mjs
cc9180db41bbab6a77997d0eee3a405f1dc6cb8a42f323fb9d52f31eba362f90  task-flow.mjs
2cd7171ef4ea18ba8efde474dfb8cbcd8197f6bfa86231527506b5c29814bbbf  stage-checkpoints.mjs
```

## 校验方法

```bash
cd "C:/Users/杨铭/Documents/Codex/2026-10-19/wo/outputs/dsh-work-evidence"
sha256sum -c FREEZE.sha256
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
