# DSH 工程证据插件

当前版本为 0.28.11，模式策略为 pb001-v24。
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
requestProjection、stubSummary、cacheOrderedStub、archiveEntries 默认关闭。
裁剪保留原始事件和取回入口；取回不可用时保留正文。

## 开发与桌面加载

开发目录：C:/Users/杨铭/Documents/Codex/2026-10-19/wo/outputs/dsh-work-evidence。
桌面加载目录：C:/Users/杨铭/Documents/DSH Desktop/home/tools/dsh-work-evidence。
桌面 web profile 的包依赖和目录联接指向加载目录。
加载目录保存独立源码与 Python 环境；宿主依赖来自已安装的桌面运行时。
修改开发目录不会自动更新桌面加载目录。
同步使用 node sync-desktop.mjs。正在运行的会话是否采用新代码取决于宿主生命周期。

index.mjs 负责组装和会话事件。
plugin-command.mjs 负责命令；source-tools.mjs 负责源码和报告入口；management-tools.mjs 负责执行、状态与管理入口。

## 当前方向

激进模式作为主要使用方向。质量模式围绕质量复核和完成提醒维护。
停止增加输入侧压缩调参和质量提示词条款。
用户要求暂停实验，当前不运行新的批次。
现行交接位于 DSH 工作区的 Codex-2026-10-23/outputs/Work-Evidence-当前交接-2026-10-31.md。
旧运行目录清理后，历史说明里的原始记录路径可能已不可用。
