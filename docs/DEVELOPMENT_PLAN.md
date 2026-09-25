# 开发规划与交付状态

作者：chenshi.ai · 版本 0.1.0

## 里程碑与状态

| 期 | 交付 | 状态 | 验收证据 |
|---|---|---|---|
| **M0** 契约验证 | 最小 Cordis 插件挂载；读通 settings / credentials / agent-request | ✅ 完成 | 插件在 desktop profile 中 `fiberPhase: active` |
| **M1** Jev 客户端 | `jev-client.js` + `classify.js` + 启发式回退 | ✅ 完成 | 单测通过；超时/429/解析失败均静默降级 |
| **M2** Tier A | `agent/request` 改 effort + 迟滞 + `/jev` 命令族 | ✅ 完成 | 策略层 15 项单测；契约测试锁定"不改前缀" |
| **M3** 度量与前端 | metrics + 设置页 + 徽章 | ✅ 完成 | `/jev-router/pricing/refresh` 实测从官网取回正确价目 |
| **M4** Tier B | 五道闸 + 三步确认 + 回滚 + 告警 | ✅ 完成 | 闸 0/1/2/3/4 各有单测；硬门禁在代码层 |
| **M5** 收尾 | 文档、署名、打包自检 | ✅ 完成 | 57 项测试全绿；README + CACHE_SAFETY |

## 五个决策（已按用户拍板执行）

1. 包名 `dsh-jev-router`
2. Tier B 只允许「任务边界切换」（`turn-boundary`）
3. Tier B 首版即发
4. 价目从 DeepSeek 官网获取，支持刷新
5. 回退关键词表直接沿用 Claude Code 的 `think` / `think harder` / `ultrathink`

## 落地过程中修正的四个真实缺陷

| # | 缺陷 | 现象 | 修正 |
|---|---|---|---|
| 1 | async 未 await | `/jev-router/status` 返回 `{}`（`JSON.stringify(Promise)`） | 加 `await`；同类问题一并排查 |
| 2 | 门控顺序 | 成本闸排在粘滞闸之后，不可行的切换也在累积粘滞计数 | 成本闸前移——它是硬可行性过滤 |
| 3 | 配置非 volatile | `/jev-router/config` 被 DSH 拒绝：`has no volatile fields` | 运行时可改字段全部标注 `.volatile()`，并用契约测试锁住 |
| 4 | **两个 `model` 混淆** | Jev 响应顶层的 `model` 是**作答版本号**（`jev-1.13.0`），被误当成路由目标 → 候选模型变成版本号 → 被白名单闸拒 → **Tier B 永远不生效** | 拆成 `jevModel`（版本）与 `model`（来自 `answers.model.choice`），并加单测 + 集成测试锁住 |
| 5 | **硬编码档位集合** | 原先把 `off\|low\|high\|max` 写死。DSH 对不支持的档位是**硬拒绝**（`llm` 服务明确声明不做 clamping），用户 profile 里的 `openai-codex`（`minimal\|low\|medium\|high`）会**整个请求失败** | 新增 `model-caps.js`：向模型注册表问能力并夹取到受支持档位；无推理元数据的模型一个档位都不设 |
| 6 | **跨 provider 路由缺校验** | 白名单只比对 model、不解析 provider，且破缓存代价按**当前**模型价目计算（实际应由**目标**模型计费），非 DeepSeek 模型无价目 → 一律 `no-pricing` 拒绝 | 支持 `provider::model` 条目、切换前校验候选可解析、成本闸改用目标路由价目、新增 `customPricing` 让用户补价 |

第 4 条由集成测试抓出，是"只有端到端测试才能发现"的典型：单测各自都过，错误在字段语义的接缝处。

| 7 | **volatile 字段当裸值读** | DSH 把可运行时修改的配置字段包成 `Object.freeze({get:()=>…})`。插件直读 `live.modelRouting === true` 恒为 false → **Tier B 永远打不开**；`confidenceFloor` 比较得到 NaN → 置信度门失效；`timeoutMs` 变成 NaN。单测传的是裸对象，所以一路全绿 | 新增 `lib/config.js`：`readConfig`/`resolveConfig` 统一拆包；策略层只接收解析后的裸值；`DEFAULTS` 成为默认值唯一真源；契约测试禁止 `live.<field>` 直读 |
| 8 | **client 模块路径假设错误** | 我按旧版插件注释以为是 `/plugins/<id>/client.js`，自检一直报 404 → 误判「前端半没交付」。实际这个版本打成合并包 `plugins/??a/client.js,b/client.js…&rev=…`，没有单独路由 | 自检改为读首页 `__DSH_BOOT__` 图谱取真实 URL，再校验合并包 200 且含署名 |

第 7 条是本项目最重要的一次发现：**只有真实启动才能暴露**。修复后，隔离实例的干净启动自检从「4 通过 / 3 失败」变成 **13 通过 / 0 失败**。

| 9 | **前端半让 DSH 无法启动** | `client.js` 的 `apply()` 直接 `slots.register(…)`。槽位由属主插件声明，而"谁的 apply 先跑"无保证；槽位未声明时 register 抛 `is not declared` → client fiber FAILED → 前端启动检查判定 `web boot: 1 entry did not activate / dsh-jev-router: failed` → **DSH 完全起不来，用户只能用安全模式自救**（该流程还会清掉 profile patch 里的自定义条目，用户因此丢了 `agent-default-model` 与 `llm-pi-ai` 两条配置） | 改用 `slots.inject(slotName, () => slots.register(…))`（等待声明，dshmarket 的既有模式）+ 整个 `apply` 包 try/catch，界面问题只降级为告警；新增 `scripts/probe-frontend.mjs` 与仿真实语义的槽位桩作为回归 |

| 10 | **误诊记录：把 `downgrade-pending` 归因于 `agent/disposed` 清空状态** | 观察到"连发两条简单消息，第二次仍是 `downgrade-pending`"，据 DSH 源码注释 *"AgentLoop emits this after driver quiescence"* 推断 agent 每轮被注销、而我在该事件上 `sessions.delete()`，于是判定策略状态被每轮清空 | **归因错误，已更正。** 反证有三：① 新代码加了 `disposedSignals` 计数后，跨轮始终为 **0**——该事件在本场景根本没派发过；② 实测改文件（mtime 与内容都改）不会重载插件，状态不丢；③ 会话日志显示两次观察之间**应用被重启过**（`request/header` 的 `reason` 从 `series` 变 `resume`，进程启动时间 `13:56:33` 晚于前一次观察）。真实原因是**进程重启清空了内存态**，不是 `agent/disposed` |
| 11 | 会话状态只存在于内存 | 应用重启后，连续确认计数（`lowStreak`）归零。若用户在两轮之间重启应用，降档需要重新累积，表现为"功能好像没生效" | 保持内存态（重启视为新起点，且 harness 自身的档位配置也随之重置，语义一致），但把这一点写进文档；状态生命周期改由 `lib/session-store.js` 统一管理 |
| 12 | 快照在两轮之间丢失会话信息 | 状态路由用 `agents.list()[0]` 找会话，拿不到 live agent 时返回 null，设置页与 `/jev status` 会退化成空白 | 新增 `sessions.mostRecent()`，快照/状态/诊断/回滚回落到最近活跃的会话 |

### 第 10 条的教训：可观测性比推理更可靠

这次误诊的价值不在结论，而在**纠正方式**。事后复盘，正确做法是：

1. **先加可观测性再下结论。** 如果一开始就把策略状态暴露成诊断字段（`lowStreak` / `sessionsCreated` / `disposedSignals`），"状态到底有没有被重建"是一个可以**直接读出来**的数，不需要从源码注释去推断。
2. **区分"状态被清空"与"状态被重建"。** 前者看 `lowStreak` 是否归零，后者看 `sessionsCreated` 是否增长——两个不同的数指向两个不同的原因。
3. **把外部事件纳入考虑。** 日志里的 `request/header.reason`（`series` / `resume`）与进程启动时间，直接指出了"进程重启"这条被我忽略的路径。

因此 `lib/session-store.js` 的价值被重新定位：它**不是**某个 bug 的修复，而是一次生命周期语义的收敛——把状态归属从"agent 实例"改为"会话"，用 TTL + LRU 取代无上限增长，并提供 `mostRecent()` 兜底。这些改进本身成立，但与原先声称的失效原因无关。

第 9 条是本项目最严重的一次事故，也是最值得记的一条教训：**前端半是唯一在 Node 侧完全测不到的代码，而它的失败是致命的**。事故前的验证覆盖了"资产是否交付"，却没有覆盖"模块是否激活"——`__DSH_BOOT__` 里有它、合并包能下载、里面确实有我的代码，但 `apply()` 抛了异常。三件事都成立，应用照样起不来。

## 隔离验证方法（本轮建立）

不必重启用户实例也能做完整实机验证：

```bash
npm install --prefix /tmp/jev-verify/pkg @deepseek-ai/dsh@0.1.7-rc.2
# 独立 HOME + 独立 profile + 独立端口（--profile 必须写在选项之前）
DSH_HOME=/tmp/jev-verify/home/.dsh node /tmp/jev-verify/pkg/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile jevtest --port 19488 --no-open
bash scripts/verify-install.sh http://127.0.0.1:19488 "$TOKEN"

# 前端启动探针（Host 检查覆盖不到这一层，必须单独跑）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --remote-debugging-port=9222 --user-data-dir=/tmp/jev-chrome about:blank &
node scripts/probe-frontend.mjs "http://127.0.0.1:19488/?token=$TOKEN" 15000
```

价值：它验证的版本与用户运行时完全一致（0.1.7-rc.2），且覆盖了单测永远覆盖不到的两类问题——宿主与插件之间的**配置交付形态**、以及**前端资产的打包与路由**。

## 测试与自检

- `node --test test/*.test.js` → **130 项**（单元 + 集成 + 前端半渲染 + 契约 + 模型能力适配 + 配置解析 + 槽位语义）
- `bash scripts/verify-install.sh [URL] [TOKEN]` → 重启后验证线上可用性（13 项：Host 快照、署名、volatile 拆包、默认关闭状态、跨站拒绝、价目、图谱收录、合并包交付、404 行为）
- `node scripts/probe-frontend.mjs <URL> [waitMs]` → 用无头 Chrome 真实验证前端启动（启动卡片、`⚡` 徽章、控制台错误）

前端半在重启前是唯一"从未运行过"的代码，因此专门用桩 React + 桩 ModuleLoader 让它真正渲染一次，避免重启后才发现白屏。

## 已核实的宿主契约（实现依据）

| 能力 | 契约要点 |
|---|---|
| `agent/request` | waterfall，`next(): Promise<LlmCallConfig>`；`LlmCallConfig = {provider, model, reasoningEffort?, temperature?, maxTokens?, stop?}`；文档明确 *cannot mutate messages* |
| `agent/inbox/inserted` | emit，`{agent, message}` |
| `llm/stream` | waterfall，返回 `AsyncIterable<StreamChunk>` |
| `commands.register` | `{name, description, input?, handler}` |
| `webServer.register` | `{kind: 'exact', path, handler(req, res)}` |
| Config schema | schemastery `z.object`；运行时字段须 `.volatile()` |
| 模型切换 | 内置选择器走 `agent.session.append('model/selection', selection)` |

## 安装形态说明

以 `link:` 安装（而非 `file:`），因为 pnpm 对 `file:` 依赖使用**硬链接**：编辑源码会替换 inode 从而断开链接，运行时读到旧代码。`link:` 建立符号链接，源码即时可见，开发循环才成立。发布到 npm 后按正常依赖安装即可。

## 未实现 / 后续

- **Tier C（skill 路由）**：`skillRouting` 仅为占位开关。
- **`jev_decide` 工具**：让模型自己调用 Jev 做判定。规划中，未实现。
- **`conversation.chat.commandview` 渲染器**：目前判定解释走 `/jev why` 的文本输出；可进一步做成富渲染的命令行。
- **自定义 Session 事件类型**：`SessionEventMap` 是固定表，第三方插件无法新增事件类型，因此判定记录走「命令 + 文本」而非自定义事件。
