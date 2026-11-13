# dsh-ops 适配改为显式选择（2026-11-14）

## 问题

插件此前把 `dsh-ops` 的 `ops_*` 工具当作默认可用的可选适配器：

- `fastedit_java` 默认开启，硬依赖 `ops_stat` + OPS CAS + 授权 shell；
- `verified_exec` 在未开启 `nativeVerifiedEdits` 时默认使用 OPS CAS；
- OPS 错误会注入一条 `work-evidence-ops` 用户消息；
- 完整工具面会展示 `fastedit_java` / `verified_exec`，即使宿主没有 OPS，调用后才返回 deopt。

这形成了“工具已发布、执行时才拒绝”的空调用面，也让默认配置与一个外部插件耦合。

## 变更

新增工作区设置 `opsAdapters`，默认 `false`。未显式启用时：

- `fastedit_java` 不从工具面发布；`fastEditEnabled` 的就绪原因记为 `ops-adapters-disabled`；
- `verified_exec` 只在 `nativeVerifiedEdits:true` 时发布；否则从工具面隐藏，直接调用返回 `ops-adapters-disabled`；
- OPS 错误建议和 `work-evidence-ops` 消息注入不运行；
- OPS 专用的读写/搜索观察分支不运行；原生 `read`/`edit`/`write` 的观察保持不变；
- 能力诊断明确标注 `opsAdapters.configured`，不再把 OPS 描述为默认路径。

启用 `opsAdapters:true` 后，原有 OPS 读取/CAS 行为恢复；`fastEditEnabled` 仍需单独开启，并继续检查 Python、`ops_stat` 和授权 shell。

## 兼容性与边界

- 旧工作区若显式设置 `fastEditEnabled:true`，在未设置 `opsAdapters:true` 前会得到明确的 `ops-adapters-disabled`，不会静默执行 OPS 调用。
- 本次不删除 OPS 代码路径，也不宣称 OPS 在所有宿主上无效；它把默认路径切回 DSH 原生工具，并保留有证据的 opt-in。
- `nativeVerifiedEdits` 的 rc.2 版本门不变。0.2.1-rc.4 / 0.2.2-rc.1 上若未启用 OPS，精确编辑会明确 deopt，而不是回退到未验证的写入。
- 未在本机运行宿主级 52 个测试文件（安装的桌面运行时缺少对应 0.2.x `cordis`）；本变更加了离线单元测试覆盖默认值、工具面和 deopt 原因，宿主级回归仍需在受支持运行时执行。
