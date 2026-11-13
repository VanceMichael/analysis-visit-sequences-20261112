# 数据与现有口径

tick 是访问内分钟，同一 tick 不规定动作顺序；phase 只标识场次。

`data/records.json` 是版本为 1 的演练数据，所有人员、机构、商品和交易均为本地合成记录。`id` 是导入记录键，不自动代表企业、访问或其他统计单位；记录键不得重复。数值字段必须有限，整数字段不得超过安全整数范围。空字符串可用于字段约定允许的未公开标签，不用零冒充缺测。

| 字段 | 类型 |
| --- | --- |
| `id` | `string` |
| `buyer` | `string` |
| `visit` | `string` |
| `tick` | `integer` |
| `zone` | `string` |
| `phase` | `string` |
| `signed` | `boolean` |

现有 `summary` 按 `zone` 清点记录，`sum` 为 `tick` 的逐行核对值，不代表统计推断或跨期业务指标。分组按键排序，行按记录键稳定处理。`data/expected-summary.json` 是独立生成的现有核算对照；`data/policy.json` 保存业务配置的演练值，当前清点命令不消费分析配置。

`inspect` 返回输入行数、字段列表与 SHA-256 指纹；指纹不依赖字段或记录排列。数据版本不支持时应直接拒绝，不做静默迁移。错误发生时命令返回非零退出码。

## 策略配置（`data/policy.json`）

`discover` 与 `replay` 消费同一份策略；复验时策略参数必须与冻结文件完全一致。

| 字段 | 含义 |
| --- | --- |
| `minSupport` | 按独立 visit 计数的最小支持数，一次访问重复匹配不多算 |
| `maxLength` | 模式的最大步骤数（同刻项集算一步） |
| `minGap` | 相邻匹配 tick 的最小间隔；为 0 也不得复用同一 tick |
| `maxGap` | 相邻匹配 tick 的最大间隔，必须不小于 `minGap` |
| `maxSpan` | 首末匹配 tick 的总跨度上限，必须不小于 `maxGap` |
| `candidateLimit` | 探索候选数量上限；触顶后输出显式截断，不宣称穷尽 |
| `discoverPhase` | 发现并冻结候选的场次（默认 `early`） |
| `replayPhase` | 只回放冻结候选的复验场次，必须与发现场次不同 |
| `permutationTrials` | 置换基线的重复次数，经验 p 值可分辨下限为 `1/(trials+1)` |
| `rngSeed` | 置换随机数种子，整数；同种子结果可复现 |

序列匹配、闭合表示、置换守恒与结论边界的完整口径见 `docs/sequences.md`。
