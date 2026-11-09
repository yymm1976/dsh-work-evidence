# 1.1.0 最终指标证据集

本目录让全新 checkout 在没有本机实验工作区的情况下复核 G3/G7 的主指标。

- `plan.json`：预注册价格、组权重、每臂单元清单、两个预注册替换单元、8 个环境无效单元。
- `units/`：30 个正式单元的脱敏最小记录（只含 token 用量、请求/工具计数、墙钟、判定标志、候选与插件哈希，不含本机路径）。
- `recompute.mjs`：从上述输入重算每成功成本、方向门禁、加权值与开销汇总。

```bash
node evidence/final-metrics/recompute.mjs
```

输出写到 `evidence/final-metrics/FINAL-METRICS-1.1.0.json`。期望值：四组等权加权 **+23.19%**；剔除零触发的 picomatch-dev 后三组 +23.06%；三类项目 dev/holdout 方向不反转。

原始单元 JSON（含完整事件与工具调用轨迹）保留在交付证据目录 `outputs/dsh-1.1.0-formal/results/`，不进入仓库。`MANIFEST.txt` 列出每个单元及其每成功成本，便于与原始文件逐一比对。
