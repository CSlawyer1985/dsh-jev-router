# dsh-jev-router

<p align="center">
  <a href="https://github.com/CSlawyer1985/dsh-jev-router/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/CSlawyer1985/dsh-jev-router/releases"><img src="https://img.shields.io/badge/version-v0.1.0-brightgreen" alt="Version"></a>
  <a href="https://github.com/CSlawyer1985/dsh-jev-router/actions/workflows/test.yml"><img src="https://github.com/CSlawyer1985/dsh-jev-router/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="https://github.com/CSlawyer1985/dsh-jev-router/stargazers"><img src="https://img.shields.io/github/stars/CSlawyer1985/dsh-jev-router?style=flat" alt="Stars"></a>
  <a href="https://github.com/CSlawyer1985/dsh-jev-router/issues"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
  <a href="https://chenshi.ai"><img src="https://img.shields.io/badge/author-chenshi.ai-orange" alt="Author"></a>
  <br>
  <b>让 Jev 决定这次该用多强的推理</b>
  <br>
  <b>默认只切思考强度，绝不碰模型、绝不碰 prompt 前缀</b>
  <br>
  语义判定 · 缓存安全 · 迟滞防抖 · 成本闸门 · 全链路可回滚
</p>

---

> **新用户？** 从 [安装](#安装) 开始，然后到 [配置项](#配置项) 填 TypeSafe API Key——两步就能用。
>
> **核心承诺：判定永不进入 prompt 前缀。** 判定结果只走 `agent/request` 改写调用配置，不改写 `messages`、不注册 system prompt。这是本插件唯一不可妥协的设计，且有契约测试守着。
>
> **仓库：<https://github.com/CSlawyer1985/dsh-jev-router>** · **作者：[chenshi.ai](https://chenshi.ai)** · 决策模型：Jev（TypeSafe AI System One）

---

## 它解决什么问题

大模型每一次回答都要先决定"想多深"。想得深就贵、就慢；想得浅就快、就便宜。而**用户其实已经把答案写在问题里了**——"今天几号"和"帮我重构这个模块的架构"显然需要不同的推理强度，但传统 Harness 只能让用户手动切、或者一刀切用最高档。

Jev 正好补这个位置：它**不聊天、不写代码**，只在你给的可穷举选项里选一个，并附上概率与置信度。所以它能干的事是：

> 把"这句话该用多强的推理"从**主观题**变成**客观题**。

但这里有个所有同类插件都会踩的坑：**换模型会破坏 prompt 缓存**。本插件对这个代价做了量化，并把它变成了出厂关闭 + 硬门禁的可选能力。

---

## 运行效果

**① 输入框徽章** —— 常驻显示当前生效的思考强度，点击循环切换（`auto → off → low → high → max`）：

```
┌──────────────────────────────────────────────────────────────┐
│  描述你想要构建的内容, / 调用指令, @ 文件或对话              │
│                                                              │
│  ⚡ auto          DeepSeek-V41-Flash ▾        High ▾      ➤  │
└──────────────────────────────────────────────────────────────┘
     ↑ Jev 判定后的生效档位
```

**② 设置页（设置 → 插件 → Jev 路由）** —— 实时度量、密钥、三档开关、价目、署名：

| 区块 | 内容 |
|------|------|
| Jev API Key | **一行三按钮**：密码输入框 + 保存 / 连通 / 清除。密钥永不回显，保存后输入框立即清空，只显示「已配置/未配置」 |
| 判定与时机 | 置信度门、`riskCeiling`、降档确认轮数、迟滞窗口、判定超时、回退档位、首步是否等待、徽章开关 |
| 模型路由参数 | `stickyRounds`、切换冷却、单会话切换上限、命中率告警阈值 |
| 缓存与成本（实时） | 累计命中率、近 50 步命中率、命中/未命中 tokens、缓存省下的钱、reasoning 占输出比 |
| 思考强度路由 | 总开关、生效档位 + Jev 判定与置信度、手动钉死档位（`auto/off/low/high/max`） |
| 自动模型路由 | 开关（默认关）+ 三步确认流程 + 最近一次闸门裁决原因 |
| 价目 | 来源、抓取时间、当前 peak/off-peak 时段、三档单价、一键从官网刷新 |
| 署名 | `dsh-jev-router v0.1.0 · 作者 chenshi.ai` |

**③ 命令** —— 判定与配置全部可在对话里完成：

```
/jev                 查看状态（等价于 /jev status）
/jev status          查看状态（档位、来源、置信度、命中率、节省）
/jev effort low      手动钉死档位（手动值永远压过自动判定）
/jev model auto on   开启自动模型路由（含缓存代价提示）
/jev why             解释本轮判定为什么是这个档位
/jev rollback        把模型回滚到切换前
/jev pricing refresh 从 DeepSeek 官网刷新价目
/jev about           插件与作者信息
```

**④ 判定解释** —— `/jev why` 输出判定依据与策略裁决链：

```
来源：jev(jev-1.13.0)
档位：high（置信度 0.91）
错误代价（score 0-3）：2.4
用户想要快答（noul 0-1）：0.12
策略裁决：upgrade → high（已夹取：clamped(max->high)）· 该模型支持 minimal/low/medium/high
模型闸门：cache-risk-not-acknowledged
```

---

## 原理：Jev 是什么

Jev 是 [TypeSafe AI](https://typesafe.ai) 的 **System One 决策模型**（作者 Diogo Almeida，前 ChatGPT 研究员）。它**不做文本生成**，只输出结构化判断。

### 三种判断原语

| 原语 | 用途 | 请求字段 | 返回字段 |
|------|------|---------|---------|
| `choice` | 从固定选项中选一个（最多 255 项） | `instructions` + `criteria`（选项名→描述的映射） | `choice`、`probabilities`、`confidence` |
| `score` | 按有序等级打分（2–10 级） | `instructions` + `criteria`（从低到高的等级描述数组） | `score`、`probabilities`、`confidence`、`legend` |
| `noul` | 判断是非 | `instructions`（可选 `criteria` 说明 true/false 各指什么） | `noul`（0–1 的"是"概率） |

一次请求可以混用多种原语。**问题字典的 key 不会发给模型**——模型只看到 `instructions` 与 `criteria`，所以选项描述必须彼此可区分。

### 本插件的三个问题

```jsonc
{
  "state": { "user_message": "帮我重构这个模块的架构" },
  "model": "jev-latest",
  "questions": {
    // 主判定：该用多强的推理
    "effort": {
      "type": "choice",
      "instructions": "How much internal reasoning effort should the assistant spend on this request? …",
      "criteria": {
        "off":  "Trivial: greeting, thanks, plain lookup…",
        "low":  "Simple and short: a single-step answer…",
        "high": "Substantial: multi-step work, code changes, debugging…",
        "max":  "Exhaustive: the user explicitly asks for complete/thorough reasoning…"
      }
    },
    // 辅助：出错代价（用于解释与将来的策略扩展）
    "risk": {
      "type": "score",
      "instructions": "If the assistant answers this request incorrectly, how costly is the mistake?",
      "criteria": ["…4 级情境描述…"]
    },
    // 辅助：用户是否想要快答
    "urgent": {
      "type": "noul",
      "instructions": "Does the user want a fast answer rather than a thorough one?"
    }
  }
}
```

> **为什么 `instructions`/`criteria` 全用英文**：官方说明中日韩文字"可以处理但准确率较低"。所以中文原话放进 `state`，判定用的指令与选项描述统一用英文。这是刻意的工程取舍，不是随手写的。

### 为什么又快又便宜

它不逐 token 续写解释，一次前向就把状态压成判断。官方标称在适配任务上**快 20–200 倍、便宜 40–400 倍**；定价是**输入 $0.042/百万 token、输出免费**，速率上限 25 万 token/秒、1200 请求/分钟。

### 已知限制（决定了插件的降级策略）

| 限制 | 本插件的应对 |
|------|-------------|
| 英语优先，CJK 准确率较低 | `instructions`/`criteria` 全英文；`state` 里放中文原话；置信度门 + 手动覆盖 |
| 只接受文本（无图/音/视频） | `extractUserText` 只取文本块，忽略图片与文件附件 |
| 不解释理由 | 判定结果里带概率与置信度；`/jev why` 展示判定与裁决链 |
| 不可微调 | 领域知识只能靠 `state` 与 `criteria` 注入 |
| 上下文 64K（状态+最长单问 ≤32K） | 只发用户原话，不发会话历史 |
| 置信度**不是正确率** | 低于阈值一律弃权，沿用 harness 默认档 |

---

## 工作原理

### 架构总览

```
┌─────────────────────── Host 半（Node / Cordis 插件） ───────────────────────┐
│                                                                            │
│  agent/inbox/inserted ──► 取用户原话 ──► JevClient.ask() ──► 解析 ──► 存档  │
│       （用户消息进 inbox）                 api.typesafe.ai         │        │
│                                                                   │        │
│                                    置信度 < 阈值 → 弃权，沿用默认档        │
│                                                                   ↓        │
│  agent/request（waterfall）◄──────────────────────────────────────┘        │
│       │  ① 档位裁决：迟滞窗口 + 降档连续确认 + 手动覆盖优先                │
│       │  ② 档位夹取：向 llm 注册表问该模型支持哪些档位，夹到最近的         │
│       │  ③ [可选] 模型路由：五道闸 → 全过才改 provider/model               │
│       └──► 返回替换后的 LlmCallConfig                                      │
│            （只碰 reasoningEffort / model / provider）                      │
│                                                                            │
│  llm/stream（waterfall）──► 抓 usage ──► 度量累计（命中率/节省/占比）      │
│  agent/turn-stopping ──► 推进迟滞计数 ──► 命中率告警检查                    │
│                                                                            │
│  对外：commands（/jev）· webServer（4 条同源路由）· settings（设置页）      │
└────────────────────────────────────────────────────────────────────────────┘
                              ▲ 同源 HTTP（静态 client 模块没有 host.call）
┌─────────────────────────────┴──────── Client 半（静态 client 模块） ───────┐
│  settings.section          设置页：密钥 / 度量 / 三档开关 / 三步确认 / 署名 │
│  conversation.input.left   徽章：⚡ + 生效档位，点击循环切换                │
└────────────────────────────────────────────────────────────────────────────┘
```

### 一次消息的完整时序

```
用户: "仔细帮我查一下天气，如果你没查好我明天可能误飞机"
  │
  ├─ ① agent/inbox/inserted
  │     取纯文本 → POST api.typesafe.ai/v1/systemone
  │     questions: effort(choice) / risk(score) / urgent(noul)
  │     ◄── { effort:{choice:"high",confidence:0.91}, risk:{score:2.4}, urgent:{noul:0.12} }
  │     存 entry.decision = { effort:"high", source:"jev(jev-1.13.0)", confidence:0.91 }
  │        └─ 失败（无 Key / 超时 / 限流 / 429）→ 回落关键词表，source="heuristic"
  │
  ├─ ② agent/request（step=1，回合起点）
  │     const cfg = await next()                    // harness 原配置
  │     ├─ 档位裁决 decideEffort()
  │     │    · 手动 effort≠auto → 直接用（manual-override）
  │     │    · 置信度 < confidenceFloor → 弃权
  │     │    · 降档且「风险高 且 非用户明说」→ 才需连续 downgradeStreak 轮确认
  │     │    · 距上次换档 < hysteresisRounds → 不动
  │     ├─ 能力夹取 clampEffort()
  │     │    向 llm.resolveModelInfo(provider, model) 问 reasoning.efforts
  │     ├─ 模型路由（仅当 modelRouting=true）
  │     └─ 返回 { ...cfg, reasoningEffort }         // messages / system 原样透传
  │
  ├─ ③ 同一轮的 step 2..n
  │     沿用 entry.state.effort，不重新裁决（单轮内锁定）
  │
  ├─ ④ llm/stream
  │     抓 usage：{ inputTokens, cacheReadTokens, outputTokens, reasoningTokens }
  │       · purpose 标记（session-title / compaction）→ 只计 auxiliaryCalls
  │       · 其余 → 累计进度量
  │
  └─ ⑤ agent/turn-stopping
        迟滞计数 +1；窗口命中率跌破阈值 → 告警并建议 /jev rollback
```

### 挂载的 DSH 扩展点

| 扩展点 | 类型 | 用途 |
|--------|------|------|
| `agent/inbox/inserted` | emit | 拿到用户原话，喂给 Jev |
| `agent/request` | **waterfall** | ★ 核心：`next()` 给出 `LlmCallConfig`，返回替换值即切换 |
| `llm/stream` | waterfall | 抓 usage，计算命中率与成本 |
| `agent/turn-stopping` | serial | 推进迟滞计数、检查命中率告警 |
| `agent/disposed` | emit | 清理会话状态 |
| `commands` | service | 注册 `/jev` 命令族 |
| `webServer` | service | 注册 4 条同源 HTTP 路由（前端半取数） |
| `settings` | service | Config schema → 自动生成设置页 |
| `credentials` | service | 读写 TypeSafe API Key（分层凭据） |
| `llm` | service | 问模型能力（支持哪些推理档位） |

### 缓存为什么不会被破坏

**短答：因为 `messages` 的构造完全不引用 effort。**

DSH 的 DeepSeek 适配器（`@deepseek-ai/dsh-llm-deepseek`）构造请求时是这样的：

```js
const effort = options.purpose === "session-title"
  ? "off"
  : options.reasoningEffort ?? connection.defaults.reasoningEffort
    ?? (connection.defaults.thinking === "disabled" ? "off" : "high");

if (!["off","low","high","max"].includes(effort)
    || connection.defaults.thinking === "disabled" && effort !== "off")
  throw new LlmError(`DeepSeek Messages does not support reasoning effort ${effort}`,
                     "UNSUPPORTED_REASONING_EFFORT");

return {
  model: options.model,
  stream: true,
  messages,                                   // ← 由会话历史独立构造，与 effort 无关
  max_tokens: options.maxTokens ?? model?.maxTokens ?? connection.maxTokens,
  thinking: { type: effort === "off" ? "disabled" : "enabled" },
  ...effort === "off" ? {} : { output_config: { effort } },  // ← 只影响这两个顶层字段
  ...system.length === 0 ? {} : { system },
};
```

三个可验证的结论：

1. **`messages` 的构造不引用 effort** —— 前缀字节不变，DeepSeek 的自动前缀缓存照常命中。
2. **档位白名单就是 `off | low | high | max`** —— 且不支持的值会在**发网络请求之前**抛 `UNSUPPORTED_REASONING_EFFORT`（写错立刻报错，不会静默烧钱）。
3. **`purpose === "session-title"` 的请求被强制 `off`** —— 说明"按用途改档"是框架既有做法，本插件只是把它扩展到用户 prompt 上。

### 三种真正会破坏缓存的操作

| 操作 | 机制 | 本插件的态度 |
|------|------|-------------|
| **切模型** | 适配器回放历史时，`readReplay` 的注释写着 *cross-model signatures are not portable*——非本源模型的 thinking 签名会被丢弃，**整段已缓存前缀被重写** | Tier B，出厂关闭 + 硬门禁 + 成本闸 |
| **把判定写进 prompt 头部** | 每轮前缀都变 → 缓存归零 | **绝不**：判定只存在于 `LlmCallConfig`，契约测试禁止出现 `systemPrompt` |
| **provider 把 effort 纳入 cache identity** | Anthropic/OpenAI 路径上，thinking 开关会改变历史形态（思考块增删）→ 重写前缀。生态里有对应缺陷报告（`zeroclaw#10786`、`zeroclaw#10777`）与修复（`deepagents#6196`，标题明确写 *for OpenAI and Anthropic*，不含 DeepSeek） | 当前走 DeepSeek Messages 路径，此条不成立；一旦切到 Anthropic/OpenAI 应调大 `hysteresisRounds` 或关闭自动改档（详见 [缓存安全](docs/CACHE_SAFETY.md)） |

---

## 策略选择

这一节是本插件的全部判断力所在。每一条都对应一个具体的失败模式。

### 三档功能模型

| 档 | 做什么 | 默认 | 缓存代价 | 为什么这样定 |
|----|--------|------|---------|-------------|
| **Tier A** | 自动思考强度（`off/low/high/max`），**模型锁定不变** | **开** | **无**——只改 `reasoningEffort` | 唯一能做到"零缓存代价"的优化，所以默认开 |
| **Tier B** | 自动模型路由（可跨 provider） | **关** | **高**——跨模型无缓存复用 | 收益常为负（见下方盈亏平衡），所以出厂关闭 + 硬门禁 |
| **Tier C** | skill 路由 | 关 | 中 | 首版仅占位，未实现 |

### 档位裁决：迟滞 + 不对称

档位切换不是"判定什么就用什么"，中间有三道过滤：

| 规则 | 配置项 | 默认 | 防的是什么 |
|------|--------|------|-----------|
| **置信度门** | `confidenceFloor` | `0.5` | Jev 不确定时**不猜**，沿用 harness 默认档 |
| **迟滞窗口** | `hysteresisRounds` | `2` | 防止在档位间高频横跳——那会让每一轮都像首次请求 |
| **降档连续确认** | `downgradeStreak` | `2` | 防止**一次误判**把推理强度砍掉 |
| **手动覆盖** | `effort` | `auto` | 手动值**永远压过**自动判定 |
| **单轮锁定** | — | 内置 | 同一轮的多步（工具循环）复用同一档位，不重复裁决 |
| **关键词豁免** | — | 内置 | 关键词回退是**用户自己写下的字面指令**，对它再要求连续确认会让回退路径价值减半，故立即生效 |

> **降档为什么不对称**：升档的最坏后果是多花点钱，降档的最坏后果是答案质量塌掉。两者不该用同一套阈值。

### 档位夹取：跨模型的能力对齐

DSH 对不支持的推理强度是**硬拒绝**——`llm` 服务的 `resolveCallConfig` 文档明确写着 *no clamping or aliasing is performed*。而各家档位命名并不一致：

| 来源 | 档位 |
|------|------|
| DeepSeek | `off` `low` `high` `max` |
| OpenAI 风格 | `minimal` `low` `medium` `high` |
| Anthropic 风格 | `low` `medium` `high` `xhigh` `max` |

所以每次裁决后都要**夹取**到该模型真正支持的档位。档位名先对齐到一条统一强度轴（`off/none/disabled`=0，`minimal/low`=1，`medium`=1.5，`high`=2，`xhigh/max`=3）：

| 情形 | 行为 | 理由 |
|------|------|------|
| 精确命中 | 原样使用 | — |
| 低于该模型下界 | 取**最省**的那一档 | 用户要的是省，不擅自升级 |
| 高于上界 | 取**最强**的那一档 | 不能因为夹取而掉质量 |
| 区间内等距 | 取**更强**的一侧 | 同上，宁可多花 |
| 模型**无**推理元数据 | **一个档位都不设** | 设了必然被硬拒绝 |
| 发生夹取 | 写日志 + `/jev why` 显示 | 实际档位与判定不一致必须可见 |

### 模型路由五道闸

按下列顺序求值——**先可行性，后平滑**：

| 序 | 闸 | 拒绝原因 | 理由 |
|----|----|---------|------|
| 0 | 用户已确认缓存风险 | `cache-risk-not-acknowledged` | 硬门禁在**代码里**，不靠文档提醒 |
| 1 | 必须是回合起点 | `not-turn-boundary` | 绝不在回合中途换模型 |
| 2 | 候选必须能解析 | `unresolvable-candidate` | 切过去只会得到一个必然失败的请求 |
| 3 | **成本比较** | `not-worth-it` / `no-pricing` | 硬可行性过滤；刻意排在粘滞之前，不可行的切换不该累积粘滞计数 |
| 4 | 粘滞（连续胜出） | `sticky-pending(n/N)` | 防抖：候选要连续 `stickyRounds` 轮胜出 |
| 5 | 冷却与预算 | `cooldown` / `switch-budget-exhausted` | 单会话切换次数上限 + 最小间隔轮数 |

### 盈亏平衡：为什么破缓存几乎不划算

设前缀 $N$ 个 token，降档每轮省下 $\Delta_{out}$ 个输出 token：

$$\underbrace{N\,(P_{miss}-P_{hit})}_{\text{破缓存代价}} \;<\; \underbrace{\Delta_{out}\cdot P_{out}}_{\text{降档收益}}$$

代入 DeepSeek **Pro 峰值**价（命中 `$0.044` / 未命中 `$1.32` / 输出 `$3.96`，每百万 token），即 $P_{out}=3P_{miss}$、$P_{hit}=P_{miss}/30$：

$$\Delta_{out}\cdot 3P_{miss} \;>\; 0.967\,N\,P_{miss} \;\Longrightarrow\; \boxed{\Delta_{out} > 0.32\,N}$$

**每破一次缓存，你得省下超过「前缀长度 1/3」的输出 token 才不亏。** 50K 前缀意味着要省 16K 输出 token——而典型思考预算在 1–8K 量级。

这正是闸 3 在**每一轮真实计算**的东西，也是 Tier B 出厂关闭的量化依据。

### 实测基线（为什么"保护缓存"优先于"省思考 token"）

从本机 `~/.dsh/sessions/**/session.jsonl.zstd` 解压统计（1935 个 step）：

```
未命中输入 :   1,311,751
缓存命中   : 532,722,304      ← 5.3 亿
命中率     :     99.75%
输出总计   :   1,140,708   （其中 reasoning 462,480 = 40.5%）
```

两个结论：

1. 命中率已经接近榨干。**任何把命中率打成 0 的操作都是灾难级。**
2. reasoning 占了全部输出 token 的 **40.5%**——思考强度确实是个大钱袋，值得调，但**必须在不破坏缓存的前提下调**。

命中率的时间形状（同一会话内连续 step）也值得注意：会话开头 1–2 步是冷启动（20% → 0%），随后爬到 97%+。**真正的缓存损失在会话边界与前缀重写，不在档位切换。**

**同一会话的独立核实**（直接从 `session.v4.jsonl.zstd` 的 439 个 usage 样本统计）：

```
cacheReadTokens  = 172,263,296
inputTokens      =   1,047,071
outputTokens     =     532,830
命中率           =      99.40%
```

> **关于 `reasoning` 这一行的口径**：上面的数字来自会话日志（跨多个 DSH build）。
> 但**当前 DSH build 里没有任何适配器填充 `reasoningTokens`**——DeepSeek、pi-ai、Anthropic/OpenAI 都不填（该字段只在 token-meter 类型与 UI 里被消费，没有生产者）。
> 所以插件在设置页显示 **「未上报」而不是 0%**：provider 不上报不等于没有思考。
> 这也意味着 **Tier B 的成本闸在当前 build 上拿不到「预测节省」，会一律以 `not-worth-it` 拒绝**——这是保守方向，符合「不确定就不动」。

### 缓存安全红线

| 红线 | 实现 | 回归测试 |
|------|------|---------|
| 判定不进 prompt 前缀 | 只经 `agent/request` 返回替换的 `LlmCallConfig` | 禁止出现 `.messages =` / `systemPrompt`；只允许赋值 `reasoningEffort`/`model`/`provider` |
| provider 只能与 model 成对切换 | 同一处赋值 | 契约测试断言成对出现 |
| 模型默认锁死 | Tier B 默认关闭 + `acknowledgeCacheRisk` 硬门禁 | 闸 0 两个用例 |
| 不破缓存地降档 | Tier A 只改 `reasoningEffort` | 策略层 15 项用例 |
| 不在回合中途换模型 | `atTurnStart = step <= 1` | 闸 1 用例 |
| 破缓存要有净收益 | 成本闸 `Δ_out > 0.32N`（按**目标**路由价目算） | 闸 3 用例 |

---

## 配置项

全部配置都在「设置 → 插件 → Jev 路由」里，DSH 由 Config schema 自动生成表单。带 `.volatile()` 的字段**改动即时生效**，不需要重启。

### Tier A · 思考强度

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 总开关 |
| `effort` | `auto` | 手动钉死档位：`auto`/`off`/`low`/`high`/`max`。手动值永远压过自动判定 |
| `confidenceFloor` | `0.5` | 低于此置信度弃权，沿用 harness 默认档 |
| `fallbackEffort` | `high` | Jev 不可用时的关键词回退默认档 |
| `hysteresisRounds` | `2` | 迟滞窗口（轮） |
| `downgradeStreak` | `2` | 降档需连续确认轮数。**只作用于高错误代价的降档**；低代价与关键词回退立即生效 |
| `riskCeiling` | `0.6` | 「低错误代价」上界（Jev 的 risk 分 0–3）。risk 不超过此值的降档立即生效 |
| `syncSessionEffort` | `true` | 把生效档位同步进**会话配置**（写 `model/selection`），让 DSH 原生的「模型后面的思考程度」跟随。关掉则原生界面永远停在会话设置上 |

> **全部可调项都在插件的设置页上**（设置 → 插件 → Jev 路由），不必去 DSH 的通用设置里找。`status.config` 会公开全部可调字段的**已解析值**，所以新增配置项会自动出现在页面上。
| `timeoutMs` | `4000` | 单次判定超时；超时即回退，绝不阻塞用户请求。**不要按热调用中位数设**——实测冷启动 1367–1463ms、热调用 358–548ms，卡在中间会导致重启后首次判定必然超时 |
| `blockOnDecision` | `true` | 首步是否等待判定结果；关闭后用上一轮判定，延迟更低 |

### Tier B · 自动模型路由

| 字段 | 默认 | 说明 |
|------|------|------|
| `modelRouting` | **`false`** | 自动模型路由总开关 |
| `acknowledgeCacheRisk` | **`false`** | 硬门禁：不勾选则策略层拒绝一切模型切换 |
| `modelSwitchMode` | `turn-boundary` | 只支持回合起点切换 |
| `modelAllowlist` | `[]` | 候选模型。裸 id = 当前 provider；`provider::model` = 跨 provider（用双冒号，因为真实模型 id 里就有斜杠与冒号） |
| `modelNotes` | `[]` | `"模型id: 说明"`，作为 Jev 的 criteria 描述 |
| `customPricing` | `[]` | 非 DeepSeek 模型的自备价目：`"provider::model=命中,未命中,输出"`（USD/1M） |
| `stickyRounds` | `3` | 候选需连续胜出轮数 |
| `switchCooldown` | `2` | 两次切换最小间隔轮数 |
| `maxSwitchesPerSession` | `2` | 单会话切换上限 |
| `hitRateAlert` | `0.8` | 窗口命中率告警阈值 |

### Tier C · 预留

| 字段 | 默认 | 说明 |
|------|------|------|
| `skillRouting` | `false` | 首版未实现，仅占位 |

### 凭据与价格

| 字段 | 默认 | 说明 |
|------|------|------|
| `apiKeyRef` | `TYPESAFE_API_KEY` | 存放 Key 的凭据名。密钥本体进 DSH 凭据存储，**不写进 profile 配置** |
| `pricingAutoRefreshHours` | `24` | 价目刷新间隔（0 = 只在启动与手动触发时获取）。**改动需重启** |
| `pricingCachePath` | `''` | 默认 `~/.dsh/jev-router/pricing.json`。**改动需重启** |
| `holidays` | `[]` | 中国法定节假日（`YYYY-MM-DD`），用于 peak/off-peak 判定 |

### 界面

| 字段 | 默认 | 说明 |
|------|------|------|
| `showBadge` | `true` | 输入框工具行的档位徽章 |
| `namespace` | `jev-router` | 设置 namespace（= loader entry id）。**改动需重启** |

> **Key 的解析顺序**（DSH 原生分层）：`继承的进程环境变量`（只读，最高）> `$DSH_HOME/.credentials.yaml`（可写，设置页输入框写这里）> `<cwd>/.env` > `$DSH_HOME/.env`。
> 如果解析到的来源是进程环境变量，设置页的写入会被拒绝（只读层遮蔽可写层），此时会返回明确错误。

---

## 安装

本插件是 **DSH bundle**：同时提供 Host 半（`lib/`）与静态 Client 半（`client/`），并在 `package.json` 里声明 `dsh.bundle.patch` 与 `dsh.client`。

### 方式 A：`link:` 安装（推荐用于开发）

```bash
# 1) 把包链接进 profile。编辑 ~/.dsh/profiles/<profile>/package.json：
#      "dependencies": { "dsh-jev-router": "link:/path/to/dsh-jev-router" }
#      "dsh": { "profile": { "bundles": [ ..., "dsh-jev-router" ] } }

# 2) 安装并重启
cd ~/.dsh/profiles/<profile> && pnpm install
```

> **为什么是 `link:` 而不是 `file:`**：pnpm 对 `file:` 依赖使用**硬链接**——编辑源码会替换 inode 从而断开链接，运行时读到的是旧代码。`link:` 建立符号链接，源码改动即时可见，开发循环才成立。

### 方式 B：作为 bundle 安装（推荐用于使用）

```bash
# 从 GitHub 安装
npm install --no-save CSlawyer1985/dsh-jev-router
# 或本地路径
dsh plugin install /path/to/dsh-jev-router
```

或直接把包放进 profile 的 `node_modules`，并在 `cordis.patch.yml` 里插入：

```yaml
- insert:
    - id: jev-router
      name: 'dsh-jev-router'
```

> `id` 必须与 `lib/namespace.js` 的 `DEFAULT_NAMESPACE` 一致（契约测试守着这一点），否则 `/jev` 写的配置与挂载的 entry 对不上。

### 首次启用后必须重启一次

Host 半在插件管理操作后可能热生效，但**前端半需要重启**——client 模块清单在启动时就写进了首页的 `__DSH_BOOT__`。重启后浏览器再刷新一次页面即可看到徽章与设置页。

---

## 使用

1. **配 Key**：设置 → 插件 → Jev 路由 → 「Jev API Key」粘贴 TypeSafe API Key → **保存**。保存后下一次对话即生效，不需要重启。密钥只写入 DSH 凭据存储，不会回显，也不进配置文件。
2. **测连通**：点**连通**——插件会用一句固定的探针消息真的打一次 Jev，然后告诉你结果。成功会显示版本号、判定档位、置信度与耗时：

   ```
   已接通 · jev-1.13.0 · off（置信度 1.00） · 430ms
   ```

   失败会明确说原因（未配置 / 请求失败 / 响应无法解析），**不会假装成功**。这个按钮让你不必靠"用一次看看"来判断是否配好。
3. **确认生效**：发 `/jev status` 或 `/jev why`，看判定的**来源**——`jev(jev-1.13.0)` 表示走真 Jev；`heuristic` 表示没配 Key 或调用失败（超时/限流）。
3. **日常使用**：什么都不用做。Tier A 默认开启，Jev 会按每条消息的难度自动升降档位。
4. **手动干预**：点徽章循环切档，或 `/jev effort high` 钉死；想交回自动用 `/jev effort auto`。
5. **开 Tier B（可选）**：设置页打开「自动模型路由」→ 三步确认 → 第二步会拿你自己的实测命中率与前缀长度算出盈亏平衡点，勾选风险确认后才能保存。

---

## 目录结构

```
dsh-jev-router/
├── lib/
│   ├── index.js         # Host 半入口：扩展点接线 + 运行时接口（配置/凭据/回滚/快照）
│   ├── classify.js      # Jev 问题构造 / 响应解析 / 关键词回退表
│   ├── jev-client.js    # TypeSafe HTTP 客户端（超时 + 429 退避 + 静默降级）
│   ├── policy.js        # 缓存安全策略（迟滞 / 五道闸 / 盈亏平衡）—— 纯函数
│   ├── metrics.js       # usage 累计、命中率、节省估算 —— 纯函数
│   ├── pricing.js       # 官网价目抓取解析 + 自备价目 —— 纯函数 + 磁盘缓存
│   ├── model-caps.js    # 模型能力查询缓存 + 档位夹取 + 白名单解析 —— 纯函数
│   ├── config.js        # 配置解析层（volatile 拆包）+ DEFAULTS 唯一真源
│   ├── routes.js        # 同源 HTTP 路由（前端半取数）
│   ├── commands.js      # /jev 命令族
│   ├── settings.js      # Config schema（schemastery）+ 设置页接线
│   └── namespace.js     # 共享常量
├── client/
│   └── client.js        # 静态 Client 模块（__ModuleLoader__.load）：设置页 + 徽章
├── scripts/
│   ├── verify-install.sh    # 安装自检（13 项，含前端资产交付）
│   ├── probe-frontend.mjs   # 前端启动探针（CDP + 无头 Chrome，覆盖"是否激活"）
│   ├── try-jev.mjs          # Jev 判定评测：同一批消息喂给 Jev 与关键词表做对比
│   └── rollback.sh          # 一键回滚（禁用插件 + 从备份恢复 patch）
├── docs/
│   ├── CACHE_SAFETY.md      # 缓存安全设计：实测基线、源码证据、盈亏平衡推导、A/B 方案
│   └── DEVELOPMENT_PLAN.md  # 开发规划、逐条缺陷记录、验证方法
├── test/                    # 178 项测试（11 个文件，分六层）
├── cordis.patch.yml         # bundle patch（loader 挂载行）
├── package.json             # dsh.bundle.patch + dsh.client 声明
└── README.md
```

---

## 测试与验证

```bash
node --test test/*.test.js      # 178 项

# 拿真实消息测 Jev 的判定质量（需要已配置 Key）
node scripts/try-jev.mjs                    # 内置样例集
node scripts/try-jev.mjs "你的消息" ...     # 自己的消息
node scripts/try-jev.mjs --json             # 输出 JSON
```

`try-jev.mjs` 会把同一批消息同时喂给 Jev 与关键词表，把差异直接摆出来。实测样例（8 条，实际版本 `jev-1.13.0`，中位耗时 426ms）：

| 消息 | Jev | 关键词表 |
|------|-----|---------|
| 你好 | `off` (1.00) | off |
| 今天几号？ | **`off`** (0.67) | high |
| 把这段 JSON 格式化成两空格缩进 | **`low`** (0.84) | high |
| 帮我彻底重构这个模块的架构… | `high` (0.65) | high |
| 这段代码线上偶发超时…帮我定位根因 | `high` (0.99) | high |
| ultrathink 一下这个一致性协议有没有漏洞 | `max` (0.64) | max |
| **不要**完整全量思考，简单说就行 | **`low`** (0.99) | **max** |
| **别** ultrathink，我只要一个是或否 | **`low`** (0.76) | **max** |

不一致 4/8，且**每一条都是 Jev 对、关键词表错**。最后两条是否定句——关键词表看到「完整全量思考」「ultrathink」就判最高档，而用户的意思正好相反。这就是「语义判定」与「关键词匹配」的差别。

### 测试分层

| 层 | 文件 | 覆盖 |
|----|------|------|
| 单元 | `policy` / `pricing` / `classify` / `metrics` / `routes` | 盈亏平衡数学、迟滞与降档确认、五道闸（含硬门禁）、价目解析（含 rowspan 错位与结构不识别）、peak 时段判定、同源校验 |
| 能力适配 | `model-caps` | 强度轴对齐、夹取规则（上下界/等距/无元数据）、`provider::model` 解析（含 ollama 那种带斜杠冒号的 id）、能力缓存的正/负 TTL |
| 配置解析 | `config` | volatile 引用拆包、缺省回退、整份配置都是引用时 `resolveConfig` 必须给出裸布尔/数字/字符串 |
| 会话生命周期 | `session-store` | 同一会话只创建一次、TTL 过期回收、LRU 容量淘汰、`disposal` 只计数不删状态、`create()` 返回值不得被额外包装 |
| 前端半 | `client` | 用桩 React + **仿真语义的槽位桩**（未声明就抛、`inject` 挂起等待）真正渲染设置页与徽章；覆盖"槽位未声明时 apply 绝不能抛"这条事故回归 |
| 集成 | `integration` | 假 Cordis 上下文把插件真正 `apply()` 起来，端到端跑 `inbox → Jev → request` 改写、同轮多 step 复用、`llm/stream` 计量、四条路由、命令族、Tier B 硬门禁与放行、跨 provider 路由 |
| 契约 | `contract` | 禁止改写 `messages`、禁止注册 `systemPrompt`、只允许改 `reasoningEffort`/`model`/`provider`、provider 与 model 成对切换、volatile 字段约定、默认值单一真源 |

### 隔离实例验证（不碰在用的实例）

不必重启正在使用的 DSH 也能做完整实机验证：

```bash
# 1) 装一份与运行时同版本的 dsh
npm install --prefix /tmp/jev-verify/pkg @deepseek-ai/dsh@<版本>

# 2) 造独立 HOME + profile（bundles 里加 dsh-jev-router，node_modules 里 link 过去）

# 3) 启动（--profile 是全局选项，必须写在其他选项之前）
DSH_HOME=/tmp/jev-verify/home/.dsh \
  node /tmp/jev-verify/pkg/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile jevtest --port 19488 --no-open

# 4) Host 侧自检（13 项）
bash scripts/verify-install.sh http://127.0.0.1:19488 "$TOKEN"

# 5) 前端启动探针（Host 检查覆盖不到这一层，必须单独跑）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --remote-debugging-port=9222 --user-data-dir=/tmp/jev-chrome about:blank &
node scripts/probe-frontend.mjs "http://127.0.0.1:19488/?token=$TOKEN" 15000
```

### 前端探针为什么必须有

因为**前端半是唯一在 Node 侧完全测不到的代码，而它的失败是致命的**——client fiber 一旦 FAILED，前端启动检查会判定：

```
web boot: 1 entry did not activate
dsh-jev-router: failed
```

然后 **DSH 直接无法启动**，用户只能用「禁用第三方插件、备份 profile patch 并重启」的安全模式自救。

本插件确实发生过这样一次事故：`client.js` 的 `apply()` 直接调 `slots.register(…)`，而槽位由**属主插件**声明、顺序没有保证；槽位未声明时 `register` 抛 `is not declared` → fiber FAILED → 应用起不来。

关键在于：**当时 `__DSH_BOOT__` 里有它、合并包能下载、包内确实有我的代码——三件事都成立，应用照样起不来。** 因为缺的这层验证是"模块是否**激活**"，而不是"资产是否**交付**"。`scripts/probe-frontend.mjs` 就是补这一层的。

---

## 三个必须遵守的 DSH 约定（都是实机启动才暴露的踩坑记录）

### 1. 前端半的 `apply()` 绝不能抛

见上一节。两条硬性做法：

- 槽位注册必须走 `slots.inject(slotName, () => slots.register(...))`——它天然等待声明完成（已发布的 dshmarket 插件用的就是这个模式）；
- 整个 `apply` 外面再包一层 try/catch，任何界面问题只降级为控制台告警。

### 2. `.volatile()` 字段在插件里是引用对象，不是裸值

DSH 把可运行时修改的配置字段交给插件时包了一层（来自 `@deepseek-ai/cosmokit`）：

```js
Object.freeze({ get: () => current, [write]: (v) => { current = v } })
```

后果：`config.modelRouting === true` 恒为 `false`（**Tier B 永远打不开**）、`config.confidenceFloor` 参与比较得到 `NaN`（置信度门失效）、`config.timeoutMs` 进 `setTimeout` 变成 `NaN`。

本插件通过 `lib/config.js` 的 `readConfig()` / `resolveConfig()` 统一拆包，策略层只接收解析后的裸值，并有契约测试禁止任何 `live.<field>` 直读。

### 3. client 模块是合并包，没有单独 URL

前端半被打进 `plugins/??<idA>/client.js,<idB>/client.js…&rev=…`，要读首页 `__DSH_BOOT__` 图谱才知道真实 URL。所以自检脚本是从图谱里取 URL 再验证，而不是硬拼 `/plugins/<id>/client.js`。

---

## 设计原则

1. **判定不进前缀**——判定结果只存在于调用配置里。这是唯一不可妥协的一条，有契约测试守着。
2. **不确定就不动**——置信度不足弃权，模型能力解析不了就不设档位，候选模型解析不了就拒绝切换。宁可不动，也不猜。
3. **代价必须量化**——"换模型便宜"这种直觉不构成理由。破缓存的代价按目标路由的真实价目逐轮计算，算不过就不做。
4. **门禁在代码里，不在文档里**——`acknowledgeCacheRisk` 未勾选时策略层直接拒绝，不依赖用户读文档。
5. **实际行为必须可见**——夹取写日志、闸门拒绝写日志、`/jev why` 展示完整裁决链。静默降级是可维护性的敌人。
6. **纯函数优先**——策略、度量、价目解析、能力夹取全部是纯函数，能单测就不用集成测试兜。
7. **界面故障不得阻断核心**——前端半整体包 try/catch；插件最坏情况是"没有界面"，绝不是"起不来"。
8. **默认值只有一份真源**——`lib/config.js` 的 `DEFAULTS` 同时供 schema 与解析层使用，契约测试禁止 schema 里出现硬编码默认值。

---

## 迭代日志

| 日期 | 版本 | 类型 | 要点 |
|------|------|------|------|
| 2026-09-25 | v0.1.0 | 初始发布 | Tier A 思考强度路由（迟滞 + 置信度门 + 关键词回退）+ Tier B 自动模型路由（五道闸 + 硬门禁 + 三步确认 + 回滚）+ `/jev` 命令族 + 设置页 + 徽章 + 署名 |
| 2026-09-25 | v0.1.0 | 修复 | **DSH 原生档位指示器永不跟随**：Tier A 只改单次调用的 `reasoningEffort`，而原生「模型后面的思考程度」读的是**会话配置**——所以界面永远停在会话设置上，用户完全看不到插件在工作。新增 `syncSessionEffort`（默认开）：档位变化时追加 `model/selection`（内置选择器走的同一条通道，字段规范 `disposition(["provider","model"], ["reasoningEffort"])`），原生界面随之更新。同步失败会记录到诊断，不静默 |
| 2026-09-25 | v0.1.0 | 修复 | **占位徽章有写全局配置的副作用**：会话未就绪时显示 `⚡ ?` 的那个按钮，其 `onClick` 会把**全局**手动档位从 `auto` **改成下一档**（通常是 `off`）。点一下就让所有会话进入 `manual-override`、Jev 判定被完全绕过，现象是「思考强度完全不变化」。占位符改为 `disabled` 且**绝不带 onClick** |
| 2026-09-25 | v0.1.0 | 体验 | 手动档位时徽章用 **🔒** 区分（自动为 ⚡），并在 title 里说明「Jev 自动判定已被绕过；点一下回到 auto」；点击语义改为**手动时一次点击直接回 auto**，不再继续往下降档 |
| 2026-09-25 | v0.1.0 | 修复 | **多会话下徽章显示别的会话的档位**：状态接口只按 `agents.list()[0]` 或"最近活跃会话"定位，开了两个会话时会串号（用户在 A 会话看到 B 会话的 `off`，以为功能坏了）。改为前端传 `?session=<id>` 精确取数（槽位契约的 `standardProps` 提供 `sessionId`），并在拿不到会话时**宁可不显示**也不显示错的值 |
| 2026-09-25 | v0.1.0 | 修复 | 指定了不存在的会话时**绝不用别的会话顶替**（返回 `scope: none`）；新增 `statusRequests` 诊断统计，用于事后确认徽章是否真的带上了会话 id |
| 2026-09-25 | v0.1.0 | 修复 | **判定超时默认值过紧导致重启后首次判定静默降级**：实测冷启动 1367–1463ms、热调用 358–548ms，而默认 `timeoutMs` 是 1500ms——正好卡在两者之间，于是每次重启后第一条消息都超时走关键词回退。默认改为 4000ms |
| 2026-09-25 | v0.1.0 | 修复 | **判定失败是静默的**（无日志、无痕迹）→ 新增 `jevFailure` 诊断字段与告警日志，并区分 `not-configured` / `timeout` / `http` / `network` / `parse`，界面能直接告诉你该去配 Key 还是调超时 |
| 2026-09-25 | v0.1.0 | 修复 | **设置页只有 4 个可调项**（其余配置项在插件页里根本不存在）→ `status.config` 改为公开全部可调字段的已解析值；设置页补齐判定时机 / 模型路由参数 / 回退档位等全部调参项 |
| 2026-09-25 | v0.1.0 | 体验 | Key 区块简化为**一行三按钮**（输入框 + 保存 / 连通 / 清除），密钥永不回显；新增 `POST /jev-router/test` 与「连通」按钮，用固定探针消息真的打一次 Jev 并报告版本 / 档位 / 置信度 / 耗时 |
| 2026-09-25 | v0.1.0 | 体验 | **降档改为「每条消息立即生效」**：新增 `riskCeiling`，用 Jev 自己的错误代价分做豁免——低代价降档不再等连续确认，高代价降档的保护完整保留；另新增「判定缺失时沿用上一轮意图」 |
| 2026-09-25 | v0.1.0 | 修复 | `agent/request` 里的 async 未 `await`，导致状态路由返回 `{}`（`JSON.stringify(Promise)`） |
| 2026-09-25 | v0.1.0 | 修复 | 闸门顺序：成本闸前移到粘滞闸之前——不可行的切换不该累积粘滞计数 |
| 2026-09-25 | v0.1.0 | 修复 | 配置字段未标 `.volatile()` 导致设置写入被拒（`has no volatile fields`） |
| 2026-09-25 | v0.1.0 | 修复 | Jev 响应里两个 `model` 混淆（顶层是**作答版本号**，路由目标在 `answers.model.choice`）→ Tier B 永远不生效 |
| 2026-09-25 | v0.1.0 | 能力 | 新增 `model-caps.js`：向 `llm` 注册表问模型支持的推理档位并**夹取**，修复硬编码档位集合导致非 DeepSeek 模型请求失败 |
| 2026-09-25 | v0.1.0 | 能力 | 跨 provider 路由：`provider::model` 条目、候选可解析校验、成本闸改用**目标**路由价目、新增 `customPricing` |
| 2026-09-25 | v0.1.0 | 修复 | **前端半导致 DSH 无法启动**（槽位声明竞态 → client fiber FAILED → `web boot: 1 entry did not activate`）→ 改走 `slots.inject` + `apply` 整体 try/catch，新增前端探针 |
| 2026-09-25 | v0.1.0 | 能力 | 新增设置页密钥输入框 + `POST /jev-router/credential`，密钥经 DSH 凭据存储写入（不进 profile 配置），保存后下一次判定即生效 |
| 2026-09-25 | v0.1.0 | 能力 | 新增 `scripts/rollback.sh`：一键禁用插件并从备份恢复 profile patch（不需要 DSH 在运行） |
| 2026-09-25 | v0.1.0 | 重构 | 会话状态生命周期收敛到 `lib/session-store.js`：按**会话 id** 保留（而非 agent 实例），TTL 30 分钟 + LRU 32 个淘汰，取代原来的无上限 Map；`agent/disposed` 只计数不删状态 |
| 2026-09-25 | v0.1.0 | 修复 | 快照在两轮之间丢失会话信息（`agents.list()[0]` 拿不到 live agent 时为空）→ 新增 `sessions.mostRecent()` 回落到最近活跃会话 |
| 2026-09-25 | v0.1.0 | 更正 | **一次误诊的更正**：曾把"连发两条简单消息仍是 `downgrade-pending`"归因于 `agent/disposed` 清空状态。加诊断后反证——`disposedSignals` 始终为 0，且会话日志显示两次观察之间**应用被重启过**（`request/header.reason` 从 `series` 变 `resume`）。真实原因是**进程重启清空内存态**，非该事件。详见 [开发规划](docs/DEVELOPMENT_PLAN.md) 第 10 条 |
| 2026-09-25 | v0.1.0 | 能力 | 新增诊断字段（`sessionsCreated` / `sessionsEvicted` / `disposedSignals` / `lowStreak` / 最近 8 次裁决）——这类不报错的失效只能靠可观测性发现 |
| 2026-09-25 | v0.1.0 | 能力 | 新增 `scripts/try-jev.mjs` 判定评测；修正 `reasoningTokens` 计量口径（当前 build 无人上报该字段 → 显示「未上报」而非假 0%）。**已用会话日志核实**：439 个 usage 样本的字段集合为 `cacheReadTokens / cacheWriteTokens / inputTokens / outputTokens / totalTokens`，无 `reasoningTokens` |

---

## 许可证

MIT © [chenshi.ai](https://chenshi.ai)

Jev 是 [TypeSafe AI](https://typesafe.ai) 的云端服务，本插件只是它的客户端。使用 Jev 需遵守 TypeSafe 的服务条款；本插件不包含任何模型权重。
