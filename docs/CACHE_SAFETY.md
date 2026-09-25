# 缓存安全设计

本文件是 `dsh-jev-router` 存在的理由。结论先行：

> **在不破坏缓存的前提下降低思考强度是纯赚；在破坏缓存的前提下降低思考强度是净亏。**
>
> 而"改思考强度会不会破坏缓存"取决于一个非常具体的实现细节，而不是直觉。

---

## 1. 缓存缓存的是什么

DeepSeek 的 Context Caching **自动开启、best-effort、只针对输入前缀**：它复用之前持久化过的前缀单元，不缓存回答。计量字段是：

```
usage.prompt_cache_hit_tokens   // 命中
usage.prompt_cache_miss_tokens  // 未命中
```

价差是致命的（官网价目，$/1M tokens）：

| 模型 | 命中输入 | 未命中输入 | 输出 |
|---|---|---|---|
| deepseek-flash（非峰值 / 峰值） | 0.003 / 0.006 | 0.15 / 0.30 | 0.6 / 1.2 |
| deepseek-v4-pro（非峰值 / 峰值） | 0.022 / 0.044 | 0.66 / 1.32 | 1.98 / 3.96 |

**命中比未命中便宜约 30–50 倍。** 这就是为什么"保护缓存"优先级高于"省思考 token"。

DSH 把它记成 `cacheReadTokens`（命中）与 `inputTokens`（未命中）——可用 `assistant/chunk` 的 usage 复算。

---

## 2. 实测基线

从本机 `~/.dsh/sessions/**/session.jsonl.zstd`（1935 个 step）解压统计：

```
未命中输入 : 1,311,751
缓存命中   : 532,722,304      ← 5.3 亿
命中率     : 99.75%
输出总计   : 1,140,708  （其中 reasoning 462,480 = 40.5%）
```

两个直接结论：

1. 命中率已经接近榨干。任何把命中率打成 0 的操作都是灾难级。
2. **reasoning 占了全部输出 token 的 40.5%**——思考强度确实是个大钱袋，难怪值得调。

命中率的时间形状（同一会话内连续 step）：

```
in= 5,954  cache=1,536   hit= 20.5%
in=15,559  cache=0       hit=  0.0%
in= 2,189  cache=8,320   hit= 79.2%
in=  213   cache=7,680   hit= 97.3%
```

**真正的缓存损失在会话开头的冷启动预热阶段（前 1–2 步），然后爬到 97%+。** 也就是说：会话边界、前缀重写、上下文压缩才是主要敌人，**effort 档位本身不是**。

---

## 3. 为什么改 effort 不破坏缓存（已在运行时源码中核实）

DSH 的 DeepSeek 适配器（`@deepseek-ai/dsh-llm-deepseek`）在构造请求时是这样做的：

```js
const effort = options.purpose === "session-title"
  ? "off"
  : options.reasoningEffort ?? connection.defaults.reasoningEffort ?? (connection.defaults.thinking === "disabled" ? "off" : "high");

if (!["off","low","high","max"].includes(effort) || connection.defaults.thinking === "disabled" && effort !== "off")
  throw new LlmError(`DeepSeek Messages does not support reasoning effort ${effort}`, "UNSUPPORTED_REASONING_EFFORT");

return {
  model: options.model,
  stream: true,
  messages,                                    // ← 由会话历史独立构造，与 effort 无关
  max_tokens: options.maxTokens ?? model?.maxTokens ?? connection.maxTokens,
  thinking: { type: effort === "off" ? "disabled" : "enabled" },
  ...effort === "off" ? {} : { output_config: { effort } },   // ← effort 只影响这两个顶层字段
  ...system.length === 0 ? {} : { system },
  ...
};
```

要点：

- **`messages` 的构造完全不引用 effort**。前缀字节不变 → 前缀缓存照常命中。
- 档位白名单就是 `off | low | high | max`（同一包的 config schema 里也是 `z.union(["off","low","high","max"])`）。
- `purpose === "session-title"` 的请求被强制 `off`——说明"按用途改档"是框架既有做法，本插件只是把它扩展到用户 prompt。
- 若 provider 配置了 `thinking: disabled`，任何非 `off` 的档位会在**发网络请求之前**就抛 `UNSUPPORTED_REASONING_EFFORT`——写错立刻报错，不会静默烧钱。

---

## 4. 三种真正会破坏缓存的操作

### ① 切模型（最严重）

适配器在回放历史时这样处理 reasoning 块：

```js
function assistant(message, model, onReplayDegrade) {
  const replay = readReplay(message, model, onReplayDegrade);
  return message.content.map((block, index) => {
    switch (block.type) {
      case "text": return { type: "text", text: block.text };
      case "reasoning": return {
        type: "thinking",
        thinking: block.text,
        ...replay?.[index]?.signature === void 0 ? {} : { signature: replay[index].signature }
      };
      ...
```

`readReplay` 的文档注释写着：**"cross-model signatures are not portable"**——对非本源模型，签名会被判定为不可用并**从历史中丢弃**。

也就是说：**换模型会重写已缓存的会话前缀**（thinking 块的 signature 消失，token 序列随之改变）。这不是"新模型没有缓存"这么简单，而是"整段历史的前缀都变了"。

### ② 把判定写进 prompt 头部

把"本轮判定=high"塞进 system prompt 或前置 context，每轮前缀都变，缓存归零。**必须只在尾部追加，或者干脆不进入 prompt**——本插件选择后者：判定只存在于 `LlmCallConfig` 里。

### ③ provider 把 effort 纳入 cache identity

在 Anthropic / OpenAI 路径上，这一条是真实存在的：开启 thinking 时思考块必须随历史回传，一开一关就要重写整段已缓存历史。生态里有对应的缺陷报告与修复：

- `zeroclaw-labs/zeroclaw#10786` — "anthropic: dropping previous-turn thinking blocks rewrites cached history at every turn boundary"
- `zeroclaw-labs/zeroclaw#10777` — "thinking/effort request config flips between turns and rewrites the whole cached history segment"
- `langchain-ai/deepagents#6196` — "treat effort changes as cache identity for OpenAI and Anthropic"

注意其中的 **"for OpenAI and Anthropic"**——不包括 DeepSeek。本插件当前走 DeepSeek Messages 路径，因此第 ③ 条不成立；一旦切换到 Anthropic/OpenAI provider，同一个插件就会变成缓存杀手。届时应把 `hysteresisRounds` 调大或关闭自动改档。

---

## 5. 盈亏平衡：破缓存要省下"前缀的 1/3"才回本

设前缀 $N$ 个 token，降档每轮省下 $\Delta_{out}$ 个输出 token：

$$\underbrace{N\,(P_{miss}-P_{hit})}_{\text{破缓存代价}} \;<\; \underbrace{\Delta_{out}\cdot P_{out}}_{\text{降档收益}}$$

代入 DeepSeek Pro 峰值价（$P_{hit}=0.044$、$P_{miss}=1.32$、$P_{out}=3.96$，即 $P_{out}=3P_{miss}$、$P_{hit}=P_{miss}/30$）：

$$\Delta_{out}\cdot 3P_{miss} > 0.967\,N\,P_{miss} \;\Longrightarrow\; \boxed{\Delta_{out} > 0.32\,N}$$

**每破一次缓存，你得省下超过前缀长度 1/3 的输出 token 才不亏。** 50K 前缀意味着要省 16K 输出 token——而思考预算通常在 1–8K 量级。结论：破缓存的降档不可能回本。

这正是 `lib/policy.js` 的**成本闸**（`not-worth-it`）在每一轮真实计算的东西。

---

## 6. 插件如何落实这些结论

| 红线 | 实现 | 回归测试 |
|---|---|---|
| 判定不进 prompt 前缀 | 只经 `agent/request` 返回替换的 `LlmCallConfig` | 禁止出现 `.messages =` / `systemPrompt`；只允许赋值 `reasoningEffort`、`model` |
| 模型默认锁死 | Tier B 默认关闭 + `acknowledgeCacheRisk` 硬门禁 | 闸 0 两个测试 |
| 不破缓存地降档 | Tier A 只改 `reasoningEffort` | 策略层单测 |
| 不在回合中途换模型 | `atTurnStart = step <= 1` | 闸 1 测试 |
| 不频繁横跳 | 迟滞窗口 + 升/降档不对称（降档需连续确认） | 迟滞与降档测试 |
| 破缓存要有净收益 | 成本闸 `Δ_out > 0.32N` | 闸 2 成本测试 |
| 可回滚、可审计 | `session.append('model/selection')` + `/jev rollback` | `/jev` 命令族 |

---

## 7. 怎么自己验证（A/B 方案）

**同一段长前缀**跑两组：

- A 组：`effort` 固定 `high`
- B 组：每轮在 `low` / `high` 之间切

判据：

```
hitRate = Σ cacheReadTokens / (Σ cacheReadTokens + Σ inputTokens)
```

提取脚本（本机已验证可用）：

```bash
zstdcat ~/.dsh/sessions/**/session.jsonl.zstd \
| python3 -c "
import json,sys
tin=thit=0
for line in sys.stdin:
    r=json.loads(line)
    if r.get('type')=='assistant/chunk':
        c=r.get('data',{}).get('chunk',{})
        if c.get('type')=='usage':
            u=c['usage']; tin+=u.get('inputTokens',0); thit+=u.get('cacheReadTokens',0)
print(f'hit rate = {thit/(thit+tin)*100:.2f}%  ({thit:,} hit / {tin:,} miss)')
"
```

预期：**两组命中率无显著差异**（因为 effort 不进入前缀）。如果 B 组明显更低，说明你所在 provider 路径命中了第 ③ 条，应当关闭自动改档。

另外注意：A/B 两组会因为 effort 不同而**生成不同的历史内容**，所以要在同一段前缀长度上比较，或只比较前若干步。

---

## 8. 两个与缓存计量有关的实现细节

### 8.1 档位夹取可能反向推高开销

夹取规则里有一条「等距时取更强的一侧」，以及「高于上界时取最强档」。这意味着判定出的档位**不总会**带来更省的结果——在 OpenAI 风格的模型上，判定 `off` 会被夹到 `minimal`（因为该模型根本关不掉思考）。

带来的后果是：**成本闸的收益侧要用夹取后的档位重算，而不是用判定值**。当前实现里，夹取后的值会写回 `state.effort`，因此同轮后续 step 与迟滞计数都基于真实生效的档位，不会出现「判定说省了、实际没省」的账目偏差。

### 8.2 标题与压缩调用必须排除在命中率之外

`llm/stream` 的 `options.purpose` 会标记 `'session-title'` 与 `'compaction'` 两类调用。它们走的是另一套 prompt（标题调用甚至被适配器强制成 `effort: 'off'`），前缀形态与对话本体完全不同。

把它们计入会让「命中率」这个指标失去意义——一个短会话里标题调用可能占掉可观比例，显示出来的低命中率是假的。因此插件把它们单独记为 `auxiliaryCalls`，不进入主指标。**读命中率时请以主指标为准。**

## 9. 价目来源与时效

价目从 `https://api-docs.deepseek.com/quick_start/pricing` 实时获取，带：

- 内置快照回退（离线/解析失败时使用，来源标记为 `snapshot`）
- 磁盘缓存（默认 24h TTL，`/jev pricing refresh` 可手动刷新）
- 完整性校验：解析结果必须三档（hit/miss/out）× 两时段（peak/off-peak）齐备，否则返回 `null` 而不猜

peak 时段：UTC 周一至周五 `01:00–04:00` 与 `06:00–10:00`，中国法定节假日除外（需在 `holidays` 里显式列出；无法识别的日子按 peak 计，偏保守）。
