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

工作区配置、会话策略、原始会话、观察记录和编辑报告继续保留。旧包不能解析新报告时，原生会话仍是历史操作的来源；不能把缺少解析结果当作没有发生修改。
