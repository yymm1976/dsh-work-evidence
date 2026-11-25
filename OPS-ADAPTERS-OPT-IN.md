# OPS 适配删除（2026-11-14，替换原 opt-in 说明）

本文件替换 `OPS-ADAPTERS-OPT-IN.md` 的旧内容。旧方案把 `dsh-ops` 的 `ops_*` 工具当作“默认关闭、显式启用”的可选适配器；那只是默认关闭，**不是删除**。本轮删除 OPS 专属代码路径；完整清单与残余风险在本文件下方，宿主条件见 `MIGRATION-1.1.2.md`。

## 已删除

- 设置 `opsAdapters` 及其就绪原因、能力诊断条目。
- 设置 `fastEditEnabled`、`fastedit_java` 工具、`fastedit-bridge.py`、`requirements-fastedit.txt`，以及对应的 Python/CAS 依赖检查。
- OPS 独占的工具名分类：`ops_read_files`、`ops_inspect_local_file`、`ops_stat`、`ops_glob`、`ops_grep`、`ops_edit_file`、`ops_write_file`、`ops_batch`、`ops_remove`、`ops_load_sdk`，以及 `ops_bash` 在 Shell 偏好表里的条目。
- OPS 错误建议注入（`work-evidence-ops` 用户消息）、OPS 经济学计数器（`opsErrorNotices`、`opaqueOpsResults`、`partialResultsObserved`、`fastEdit*`）和 OPS 专用观察分支（分页空页提醒、批量 mutation 记录、OPS 搜索记录）。
- `verified_exec` 的 OPS CAS 后端。`fastEditPython` 保留：它是 `memberParsing` 的 tree-sitter 解释器路径。

## 保留

- 原生 `read`/`edit`/`write`/`grep`/`glob` 的观察、账本、证据、交接与压缩行为，以及权限语义。
- `pwsh` 与 `bash` 支持；`work_exec`、`work_probe`、保留计算（`work_compute`）、`ptc_fastpath`、`project_evidence`、`source-members` 成员解析（`memberParsing`）。
- `verified_exec` 的原生条件写入后端（需 `nativeVerifiedEdits:true`）。

## 旧工作区兼容

写有 `opsAdapters` 或 `fastEditEnabled` 的旧工作区文件仍能加载：两个键按退役设置强制为 `false`，不会启用任何行为。删除这两个键或保留它们都不影响其余配置。

## 宿主条件

`verified_exec` 的原生条件写入要求 `dsh-tools`、`dsh-fs-local`、`dsh-tool-fs` 位于同一 0.2.2-rc.1 或 0.2.2-rc.2 版本（`native-cas.mjs` 同时校验三个版本号，并要求注入官方 `LocalFileSystem` 或受支持的 `SandboxedFileSystem`）。在 0.2.1-rc.4 或混合版本上即使 `nativeVerifiedEdits:true`，调用也返回 `reason:"cas-file-tools-unavailable"`、`missing:["rc2-native-conditional-write"]`、`effectState:"none"`。工具面是否发布该工具由 `nativeVerifiedEdits` 决定（默认 `false` 时不发布），而后端能否执行由宿主版本决定；这是两个不同条件。它不会退回未带版本条件的普通写入。这是有意牺牲：没有 OPS CAS 之后，这些宿主组合上没有可用的 `verified_exec` 后端。
