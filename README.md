# visit-sequences

tick 是访问内分钟，同一 tick 不规定动作顺序；phase 只标识场次。

项目提供本地记录校验、输入指纹、按 `zone` 的原始核算，以及访问序列的发现（`discover`）与冻结复验（`replay`）。
序列单位是一个 buyer 的一次 visit：同一 tick 的动作折叠为无序项集，支持度按独立 visit 计；
订单意向 `signed` 只做事后描述分组，不进入访问项。分析人员可以保留完整输入并复查每次导出的 JSON；
原始数据不被命令改写。业务配置位于 `data/policy.json`，字段约定在 `docs/data.md`，
序列分析口径见 `docs/sequences.md`。

## 运行

使用 Node.js 22 LTS（>=22.22.1 且 <23）和 npm，无第三方运行依赖。
`.nvmrc` 选择 22 主版本，清单与锁文件记录相同的兼容范围；Dockerfile 仍固定基础镜像摘要，容器构建可精确复现。

```sh
npm ci --ignore-scripts --no-audit --no-fund --offline
npm run build
npm test
npm run summary
node src/cli.js inspect --input data/records.json
node src/cli.js summary --input data/records.json --out var/summary.json
node src/cli.js discover --input data/records.json --policy data/policy.json --out var/frozen.json
node src/cli.js replay --input data/records.json --policy data/policy.json --frozen var/frozen.json --out var/replay.json
npm run demo
```

`discover` 在前半场（默认 `early`）发现并冻结候选；`replay` 在后半场（默认 `late`）只回放冻结候选、
不重新发现，并输出置换基线与每条建议的展开证据（支持 visit 与匹配 tick）。
候选数量上限触发时输出显式截断标记，不会把未搜索完表述为没有其他模式。

`npm run demo` 在本地打印输入、现有核算、配置、冻结发现与复验结果并生成 `var/` 下的 JSON，
不访问网络、不等待真实业务时间，通常几秒内完成。输出目录可删除后重新运行，测试只使用临时目录。

## 容器

```sh
docker build -t visit-sequences:local .
docker run --rm --network none visit-sequences:local
```

Dockerfile 固定 Node.js 基础镜像摘要，构建时执行语法检查和测试。镜像构建完成后演示无需联网；可覆盖命令运行 `npm test`。构建不需要真实账号、邮件服务、数据库或线上数据。

## 目录

- `src/dataset.js`：记录校验、规范序列化、数据指纹（`recordsFingerprint` 为冻结/复验共用口径）。
- `src/domain.js`：当前业务分组核算。
- `src/sequences.js`：visit 项集序列、统一匹配器、候选扩展与闭合判定。
- `src/policy.js`：间隔、跨度、模式长度、候选上限、场次与置换配置的校验。
- `src/discover.js`：只剪零嵌入分支的宽度优先发现与候选核算。
- `src/permutation.js`：保留访问长度与同刻项集结构的置换基线。
- `src/replay.js`：冻结候选的独立场次回放、证据展开与基线汇总。
- `src/cli.js`：本地读取、检查、发现、回放和导出入口。
- `src/output.js`：以临时文件写入后替换完整 JSON。
- `docs/sequences.md`：序列语义、剪枝取舍、冻结复验与结论边界。
- `test/`：输入约束、领域核对、序列语义、发现截断、置换守恒、回放与命令回归。
- `data/`：合成记录、独立核对值及本地业务配置。
