# 1.1.2 回退说明

切换旧包不会撤销已经生效的文件修改。一次调用未完成全部文件时，以记录中的逐文件效果为准。

1. 结束使用新版本的会话，并让宿主释放插件。
2. 检查每个仍使用该插件的工作区。
3. 从各工作区 `.dsh/work-evidence/config.json` 移除下列新增键，保留其他设置。
4. 加载与目标宿主匹配、已有加载依据的旧插件包。
5. 重新启动会话。
6. 查看 `/work-evidence status` 和 `/work-evidence features`。
7. 确认原生读取和修改入口仍能使用。

回到 1.1.0 前需要移除的键为：

- `nativeVerifiedEdits`
- `fileProfiling`
- `structuredJson`
- `hostNodeFallback`
- `nativeShellScriptReuse`
- `probeReplay`

仅把这些设置改为 `false` 不足以兼容严格校验设置名称的旧包。旧包若不能支持 rc.2，应同时选择已有兼容依据的 rc.1 或 rc.4 宿主。

**OPS 删除后的回退差异。** 本构建删除了 `opsAdapters`、`fastEditEnabled`、`fastedit_java`、`fastedit-bridge.py`、`requirements-fastedit.txt` 和 OPS CAS 后端。回到仍带 OPS 适配的旧包时：

- 旧包会重新接受 `opsAdapters` / `fastEditEnabled`，但本构建写出的工作区配置里没有这两个键（本构建按退役设置强制为 `false`）。**每一个**要回到 OPS 路径的工作区都要显式设置 `opsAdapters:true`——包括本构建保存过配置的既有工作区，不只是新工作区。已保存的文件不再包含这两个键，旧包会使用自己的默认值（OPS 关闭）。
- `fastedit_java` 的 Python 依赖现在由 `requirements-source-members.txt` 记录；旧包期望 `requirements-fastedit.txt`。两者是同一组版本（`fastedits==0.5.0`、`tree-sitter-java==0.23.5`），复制或改名即可。
- 本构建在宿主 0.2.1-rc.4 / 0.2.2-rc.1 上不提供可用的 `verified_exec` 后端（`rc2-native-conditional-write` 不可用）。**工具面与实际后端是两件事**：`nativeVerifiedEdits:true` 时工具面仍会发布 `verified_exec`，但每次调用都返回 `cas-file-tools-unavailable`、`missing:["rc2-native-conditional-write"]`、`effectState:"none"`，不写入任何文件；`/work-evidence feature nativeVerifiedEdits` 会报 `rc2-native-conditional-write-unavailable`。这是已知的时序限制：工具面在同步组装阶段无法等待宿主版本探测。旧包在这些宿主上会退回到 OPS CAS，因此回退会**恢复**这两个宿主上的精确编辑能力——但同样重新引入了 OPS 依赖。

工作区配置、会话策略、原始会话、观察记录和编辑报告继续保留。旧包不能解析新报告时，原生会话仍是历史操作的来源；不能把缺少解析结果当作没有发生修改。本构建删除的 OPS 报告与计数器字段（`opsErrorNotices`、`opaqueOpsResults`、`fastEdit*`）不会出现在新快照里；旧包读取旧快照时不受影响。

工作区配置、会话策略、原始会话、观察记录和编辑报告继续保留。旧包不能解析新报告时，原生会话仍是历史操作的来源；不能把缺少解析结果当作没有发生修改。
