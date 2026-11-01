# DSH 工程证据插件

本页描述核查分支 0.28.13，模式策略为 pb001-v24。
main 和桌面仍使用 0.28.11。
插件提供任务指引、观察账本、历史取回和按需工程工具。
历史说明见 [HISTORY.md](HISTORY.md)。历史结果不代表当前版本的实际效果。

## 模式与开关

Ultra 档位使用质量模式。模型原生提供 Ultra 时直接发送原生档位；仅支持 Max 时，插件增加 Ultra 选项并在发送时映射为 Max。
其他档位在 aggressiveMode 开启时使用激进模式，关闭时交给宿主。
切换从下一次模型请求生效。旧 mode 字段不再控制模式。
旧工作区明确设置 mode:default 且未设置 aggressiveMode 时，保留交给宿主的行为。

可用命令：

```text
/work-evidence status
/work-evidence detail
/work-evidence mode
/work-evidence on
/work-evidence off
/work-evidence inherit
/work-evidence aggressive on
/work-evidence aggressive off
```

mode 只查询状态。旧的 mode <名称> 和 workspace-mode 命令不再设置模式。
总开关同时控制质量模式和激进模式。关闭激进开关后，非 Ultra 档位停用插件自动处理。
work_status 始终保留；历史中仍有取回引用时保留 work_recall。

## 质量复核与完成提醒

qualityReview 控制质量模式的最终答复复核。
复核使用当前会话路由和有界历史；结果没有充分依据时保留原答复。
复核优先携带已修改文件在修改后读到的正文，并限制证据长度。
当前 auto/max 的 v5、v6、v7 诊断均未形成可用判断。
v7 的较短提示词仍耗尽 8192 输出 Token，尚未采用；诊断记录见现行功能核查页。

completionNotice 独立控制阶段摘要后的继续提醒，默认开启。
插件启用的档位均可使用。提醒要求模型继续已授权且能执行的工作。
用户暂停、等待用户决定或存在阻碍时结束。“下一步：无”不触发提醒。
提醒和质量复核使用各自的状态，不互相替代。

## 工具与存储

- work_exec 执行当前任务已经允许的 Python 或 Node 程序；retained 模式保留只读 Node 状态。
- work_recall 按 seq 取回原始会话文字。offset 和 nextOffset 是 JavaScript 字符串位置。
- work_status 查看状态，修改工作区配置或会话开关。
- project_evidence 读取工程、归档和依赖源码；work_report 保存明确请求的工作报告。
- work_probe 执行已明确的原生调用；索引、候选、PTC 快速路径及精确编辑工具由 full 工具面提供。

compact 工具面保留工作所需入口。明确只读任务隐藏 work_exec。
原生 DSH 文件服务承担核心读取；OPS 只用于可选读取和精确编辑。
FastEdit Python 路径由 fastEditPython 设置。
省略 run_code 或原生 Shell 的界面说明时，插件在宿主执行前补充说明，避免宿主修改只读参数失败。

工作区设置位于 .dsh/work-evidence/config.json。
会话开关位于 .dsh/work-evidence/sessions/<session-id>.json。
自动观察记录放在宿主会话目录或用户会话目录，避免混入项目源码检索。
配置无效时自动处理关闭，并保留错误信息。

## 常用设置

```js
await tools.work_status({config: {
  aggressiveMode: true,
  completionNotice: true,
  qualityReview: true,
  toolSurface: 'compact'
}});
await tools.work_status({session_enabled: false});
await tools.work_status({session_enabled: null});
```

历史裁剪采用 forecast；时机交给宿主。
旧 online-batch 和 adaptive 设置分别归入 forecast 和 native。
swLedger 和 swEviction 默认开启。
SW 只替换旧的完整成功输出，要求后续仍有相同正文可见。
替换后的地址能取回原始事件。
没有相同正文时，SW 与外层协调器不遍历历史或评估缓存费用。

requestProjection、projectionRestore、stubSummary 默认关闭，尚无稳定费用收益结论。
deferPressureCompaction 也保持默认关闭。
开启后，仅在宿主压力阈值早于消息预算的 60% 时延后压缩。
消息预算是上下文容量减去主请求输出预留量。
该次压力压缩的摘要输出预留上限为 16384 Token。
普通阈值、溢出恢复和手动压缩沿用宿主参数。
裁剪保留原始事件和取回入口；取回不可用时保留正文。

以下可选路径已移除：

- reasoningHistory：不再编辑私有推理，原生消息保持原文。
- programHistory：不再缩短历史工具程序；原始调用仍可取回。
- ledgerFoldPlan、ledgerFoldWrite：不再扫描或写入账本折叠；读取回执、失效和问题标记保留。
- cacheOrderedStub、archiveEntries：不再提供独立模式。
- executionAdvice、finishAdvice：不再增加执行或收尾建议。

旧配置中的这些布尔字段兼容读取后固定为 false。
早已退役的 taskEffort、nativeReadView 和 nativeExecutionEvidence 也退出有效功能列表。
旧的缓存排序和归档环境变量不能重新启用对应模式。
stubSummary 保留问题处理标记、事件指针和原文取回。

## 开发与桌面加载

开发目录：C:/Users/杨铭/Documents/Codex/2026-10-19/wo/outputs/dsh-work-evidence。
核查工作树：C:/Users/杨铭/Documents/Codex/2026-10-19/wo/outputs/dsh-work-evidence-verify。
桌面加载目录：C:/Users/杨铭/Documents/DSH Desktop/home/tools/dsh-work-evidence。
桌面 web profile 的包依赖和目录联接指向加载目录。
加载目录保存独立源码与 Python 环境；宿主依赖来自已安装的桌面运行时。
修改开发目录不会自动更新桌面加载目录。
同步使用 node sync-desktop.mjs。正在运行的会话是否采用新代码取决于宿主生命周期。

index.mjs 负责组装和会话事件。
plugin-command.mjs 负责命令；source-tools.mjs 负责源码和报告入口；management-tools.mjs 负责执行、状态与管理入口。

## 当前方向

激进模式作为主要使用方向。质量模式围绕质量复核和完成提醒维护。
用户已恢复激进模式、压缩和提示词实验。
功能核查单独使用 auto/deepseek-v4.1-flash / max。
当前目标是将保留候选补齐后默认开启，收益不足或不稳定的路径移除。
40% 延后方案正在独立研究树比较；按有效请求视图衔接原生压缩的方案等待其结束。
请求预算方案和 v7 复核均未进入核查分支，不能按研究树的行为解释本页配置。
stub 比较虽已结束，但没有实际触发 stub，不能将费用差作为采用依据。
尚未完成的候选比较和质量反例统一记录在现行功能核查页。
核查改动保留在 verify/function-audit，不并入 main 或同步桌面。
现行交接位于 DSH 工作区的 Codex-2026-10-23/outputs/Work-Evidence-当前交接-2026-10-31.md。
旧运行目录清理后，历史说明里的原始记录路径可能已不可用。

## 功能测试

```powershell
node --test --test-concurrency=2 test/*.test.mjs
```

宿主测试使用已安装 DSH 运行时和脚本化模型，不调用远程模型。
OPS 和 FastEdit 成功路径使用本机已安装环境。
环境缺失时，对应成功路径会显示 skipped。
开关触发和历史取回通过，不能据此推断真实任务费用下降。
费用比较和未证实的效果见 DSH 工作区现行功能核查页。
