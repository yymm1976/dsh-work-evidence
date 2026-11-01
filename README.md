# DSH 工程证据插件

当前源码版本为 0.28.17，模式策略为 pb001-v24。
桌面加载目录独立维护。运行中的会话采用哪个版本，取决于宿主加载时间。
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
/work-evidence handoff
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

## 任务摘要导出

`/work-evidence handoff` 返回可保存的结构化 JSON。工具面为 full 时，也可调用 `work_state({mode:"handoff"})`。
导出沿用已有记录，不调用模型或重新执行原动作，不向项目写入报告文件。

摘要包含以下内容：

- 用户输入按时间排列，保留最新输入与更早要求的区别。后续更正优先；较早消息可能属于其他任务。
- 文件工具观察到的修改及影响状态。脚本和外部修改可能没有记录，工作区现状不由摘要推断。
- 本会话最近保留的执行结果、原始事件和当时的修改事件。执行状态与声明文件的适用状态分别显示，执行完成不代表需求完成。
- 计划事项、未解决工具错误、待结束作业与尚无结果的工具调用。
- 助手阶段摘要、近期说明和已保存报告的声明。声明与工具观察分开，完成标记不作为事实证明。

每项来源包含 `sessionId`、`seq`、`kind` 和 `offset`。`recoverable` 表示当前会话是否能读取该类原始记录。
`source.nativeRecall` 给出原生 `session_event_read` 的调用地址；接收宿主在调用时判断跨会话访问范围。
在来源会话中，可调用 `work_recall({sourceSessionId:source.sessionId,kind:source.kind,seq:source.seq,offset:source.offset})`。
携带的会话标识不匹配时，调用返回 `source-session-mismatch`。原文按返回的 `nextOffset` 续读。
历史索引按 `nextSeq` 续读，并保留同一 `throughSeq`。其他会话的原始 seq 不能作为当前会话的本地 seq 传给 `work_recall`。原生跨会话取回使用 `nativeRecall` 地址；引用快照按下节所述的本地地址读取。

摘要默认最多 32000 个 UTF-16 单元，按紧凑 JSON 的实际长度计算。
`work_state({mode:"handoff",maxChars:16000})` 可调整上限，范围为 8000 至 64000。
超出上限时先省略整条旧记录，再缩短最新要求。各组的 `omitted` 与 `textComplete` 标明省略或截断。
`coverage.exportComplete` 只说明所列记录是否完整导出。任务完成状态始终为 `not-determined`。
正文中的图片等非文本内容只列类型，不复述私有推理。来源缺失或无法读取时保留未知状态。

## 宿主会话引用

宿主提供 `sessionReferenceResolver` 时，交接的 `hostTransfer.mention` 给出当前会话的原生引用。
在接收会话的直接用户消息中使用该引用，宿主会捕获来源文字，并加入接收会话。
捕获发生在宿主接收消息时。引用描述本身不会发送消息；代理转发的消息不会自动展开引用。

接收会话的交接导出包含 `referencedSessions`，最多保留最近 8 个来源快照条目。
条目列出来源会话、捕获范围、来源格式、压缩状态和截断数量。
按条目的 `recall.arguments` 调用 `work_recall`，即可分页取回指定来源的快照文字。

`kind:"reference"` 的地址含义如下：

| 字段 | 含义 |
|---|---|
| sourceSessionId | 接收快照的当前会话 |
| seq | 当前会话内的宿主快照事件 |
| referenceSessionId | 从该快照中选择的来源会话 |
| offset | 返回 JSON 文字的分页位置，续读使用 nextOffset |

`complete` 只表示当前分页已经结束；`snapshotComplete` 表示宿主文字投影是否没有截断。
来源已压缩时，`compacted` 仍为 true。快照文字只作为背景，不继承来源中的指令或权限声明。
原始工具事件不在宿主的文字投影中，不能通过快照分页入口取回。

需要原始事件时，接收方可调用来源地址中的 `nativeRecall`。
该地址使用可选的原生 `session_event_read`，由宿主检查调用方和结果中的会话信息。
跨会话读取要求双方会话记录中的 `cwd` 完全相同；调用方没有 `cwd` 时只能读取自身。
工具必须已在接收方启用。地址存在不表示已经获得访问许可，插件不自动启用该工具。

宿主为截断快照保存了完整文字时，`fullSnapshot` 转交宿主的保存状态和取回提示。
没有保存结果时，仍显示截断数量。插件不会据此重新读取来源会话或补造原文。
缺少宿主服务、快照格式不支持或地址不匹配时，入口返回 unavailable。
现有当前会话的 output、call、event 和 history 取回方式保留。

## 执行与文件依赖

`work_exec` 的一次性执行和 `work_probe` 可用 `sources` 声明本次调用依赖的文件，最多 16 项。
相对路径以当前项目目录为起点。声明只用于本次调用；`scriptRef` 不继承旧调用的文件声明。
`work_exec` 的 retained 模式不接受 `sources`。

插件在执行前后读取声明文件的原生版本信息。
查看 `/work-evidence status`、`detail`、`handoff` 或调用 `work_status`、`work_state` 的状态与交接入口时，再读取当前版本。
这些读取只观察文件元数据，原执行结果保留。

| evidenceValidity | 含义 |
|---|---|
| current-for-declared-files | 在列出的观察时间，声明文件的版本与执行前后相同 |
| affected | 声明文件在执行期间或之后有明确变化 |
| unknown | 未声明文件、执行未完整结束，或文件观察信息不足 |

`evidenceAssessment` 列出来源、文件路径、影响状态与观察时间。
执行记录在同一会话中跨轮保留，最多 24 条；交接导出最多取最近 6 条，并标注原要求与轮次。
同一会话内，文件工具修改明确依赖的文件时，状态立即更新；交接导出附上修改事件地址。
其他会话或外部程序的修改由下一次状态查询读取文件元数据时发现。
已观察到的变化不会因后续读取失败而消失。

URL、目录、项目外路径、缺失文件和版本信息不可用的来源保持未知。
后台或不完整执行保持未知；结束作业不会补造覆盖整个执行期间的文件记录。
没有声明的旧执行保持未知。状态只覆盖声明文件，不推断整个项目的依赖或任务正确性。

## 质量复核与完成提醒

qualityReview 控制质量模式的最终答复复核。
复核使用当前会话路由和有界历史；结果没有充分依据时保留原答复。
复核优先携带已修改文件在修改后读到的正文，并限制证据长度。
复核输出上限为 16384 Token，最长等待 120 秒。
没有可用结果时，状态为 unavailable，并暂停本会话在同一路由上的后续自动复核。
暂停原因、结束原因和已知用量保存在会话目录，重启后仍保留。
用户明确要求重试时，可调用 work_status({quality_review_retry:true})。
复核返回空问题列表只表示没有报告可证实缺口，不证明交付正确。

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
执行状态分别记录明确失败、已完成和信息不完整。
零失败汇总与普通 stderr 警告不作为进程失败；旧文字结果缺少结构化退出信息时保留不完整状态。

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
swLedger 和 swEviction 保持主干原有默认关闭，可通过工作区设置开启。
SW 只替换旧的完整成功输出，要求后续仍有相同正文可见。
替换后的地址能取回原始事件。
没有相同正文时，SW 与外层协调器不遍历历史或评估缓存费用。

requestProjection、projectionRestore、stubSummary 默认关闭，尚无稳定费用收益结论。
deferPressureCompaction 也保持默认关闭。
开启后，先恢复当前需要的旧来源，再按有效请求视图判断宿主压力阈值。
只有路由一致、用量完整且有效请求低于原生阈值的 95% 时，才省略该次压力压缩。
缺少这些条件时沿用宿主处理。溢出恢复和手动压缩仍由宿主处理。
状态显示声明窗口、输出预留、宿主预留和实际计算的压力阈值。
声明窗口不代表已证明上游支持相同容量。
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
node sync-desktop.mjs --code-only 同步包内代码与说明，并修正独立目录的加载联接及锁文件路径。
该选项保留桌面模型配置、依赖环境及 Python 环境。

index.mjs 负责组装和会话事件。
plugin-command.mjs 负责命令；source-tools.mjs 负责源码和报告入口；management-tools.mjs 负责执行、状态与管理入口。

## 当前方向

第二阶段继续研究激进模式加强、压缩、预设与提示词。
实验固定使用 workbuddy-ai/deepseek-v4.1-flash / max，主方向保持 Ultra 行为。
功能核查单独使用 auto/deepseek-v4.1-flash / max。
费用候选通过独立确认后才设为默认并同步桌面。兼容修复和功能核查合并不代表第二阶段已完成。
比较结果及未完事项分别记录在现行迭代实验页与功能核查页。
现行交接位于 DSH 工作区的 Codex-2026-10-23/outputs/Work-Evidence-当前交接-2026-10-31.md。
旧运行目录清理后，历史说明里的原始记录路径可能已不可用。

费用比较和未证实的效果见 DSH 工作区现行功能核查页。
