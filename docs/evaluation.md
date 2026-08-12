# 离线评估说明

`pnpm eval` 读取评估记录和来源映射，再计算确定性指标。默认记录位于 `eval/records.json`，来源映射位于 `data/processed/source-map.json`。也可以同时传入其他文件：

```bash
pnpm eval -- path/to/records.json path/to/source-map.json
```

仓库内的记录是合成轨迹，用于验证指标计算和行为契约，不代表任何模型的实际质量。评估真实模型时，先把本地查询轨迹转换为相同结构，再运行该命令。

## 覆盖范围

评估文件必须包含以下场景：

- 跨文档回答；
- 产品编码精确匹配；
- 价格等数值问题强制回源；
- 同一线程的多轮追问；
- 不同线程的状态隔离；
- 知识库外问题拒答；
- 无效引用被服务端拒绝。

`parseRecords` 会检查场景是否齐全。`behavior_pass_rate` 检查拒答、原始来源回退和引用守卫是否符合记录中的期望值。

## 指标定义

检索指标只统计 `expected.source_ids` 非空的记录。所有检索相关性均按 `source_id` 判断，并对记录做宏平均。

| 指标 | 定义 |
| --- | --- |
| `recall` | 已检索相关来源数除以期望来源数。 |
| `precision` | 已检索相关来源数除以检索来源数。 |
| `hit_rate` | 至少命中一个期望来源的记录比例。 |
| `mrr` | 首个相关来源排名倒数的平均值。 |
| `ndcg_at_5` | 前 5 个检索结果的二元相关性 NDCG。 |
| `context_precision` | 相关来源出现位置上的 Precision@k 平均值。 |
| `context_recall` | 来源 ID 粒度的上下文召回率；在当前离线实现中与 `recall` 相同。 |
| `citation_validity` | 最终响应中存在于有效来源集合的引用数，除以最终引用总数。没有最终引用时不制造无效引用。 |

`proposed_citation_ids` 保存模型最初提出的引用，`final_citation_ids` 保存服务端校验后的引用。计算器以来源映射为准，不接受评估记录自行声明有效来源。引用守卫拒绝未知引用后，未知 ID 不会进入最终响应。因此，`citation_validity` 只衡量 Agent 实际收到的引用。

## 人工审核边界

首版不接入 RAGAS，也不使用第二个 LLM 充当裁判。以下维度不能由当前脚本自动证明：

- Faithfulness：回答中的每项陈述是否由引用证据支持；
- Answer Correctness：回答是否完整、准确地解决问题。

评估真实模型时，应保存问题、回答、候选条目、证据片段、最终引用和拒答原因，并由人工审核这两个维度。不要把本脚本的检索分数表述为 Faithfulness 或 Answer Correctness 分数。
