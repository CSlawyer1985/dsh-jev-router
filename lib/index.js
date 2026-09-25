/**
 * dsh-jev-router — Host 半入口。
 *
 * 作者：chenshi.ai · https://chenshi.ai
 *
 * 职责：在模型调用前后插入一层 Jev 判定与缓存安全策略。
 *
 * 三条红线（详见 docs/CACHE_SAFETY.md）：
 *   1. 判定结果只经 agent/request 改写 LlmCallConfig —— 永不进入 system prompt，
 *      不改写 messages，因此前缀字节不变、前缀缓存照常命中。
 *   2. 自动模型路由默认关闭，且必须显式确认缓存风险才生效（硬门禁）。
 *   3. 换档有迟滞、单轮内锁定，避免高频横跳。
 */

import { homedir } from 'node:os';

import { JevClient } from './jev-client.js';
import {
  buildQuestions,
  extractUserText,
  heuristicEffort,
  parseDecision,
  EFFORTS,
} from './classify.js';
import {
  createSessionState,
  decideEffort,
  shouldSwitchModel,
  predictOutputSaving,
  estimateSwitchCost,
  breakevenOutputTokens,
} from './policy.js';
import { createMetrics, recordUsage, snapshot, shouldAlert } from './metrics.js';
import {
  createPricingStore,
  priceFor,
  parseCustomPricing,
  customPriceFor,
  SNAPSHOT,
} from './pricing.js';
import { createCapabilityCache, clampEffort, parseAllowlistEntry } from './model-caps.js';
import { DEFAULTS, readConfig, resolveConfig } from './config.js';
import { Config, AUTHOR, AUTHOR_URL, installSettings, defaultPricingPath } from './settings.js';
import { registerCommands } from './commands.js';
import { registerRoutes } from './routes.js';

export const name = 'dsh-jev-router';
export const inject = [];
export { Config };

export function apply(ctx, config) {
  // 配置就地更新即可生效（loader 持有同一个对象引用）。
  const live = config ?? {};

  /**
   * 读单个配置值。**必须**走这里：volatile 字段在运行时是引用对象而不是裸值，
   * 直接读 `live.x` 会得到 `{}`，让 `=== true` 之类的比较静默失效。
   */
  const C = (key, fallback = DEFAULTS[key]) => readConfig(live, key, fallback);

  /** 策略层要的是裸值对象。 */
  const policyConfig = () => resolveConfig(live);

  /** @type {Map<string, {state: object, decision: object|null, pending: Promise<void>|null, reasoningSum: number, reasoningSteps: number, previousModel: string|null}>} */
  const sessions = new Map();
  const metrics = createMetrics({ windowSize: 50 });
  const pricingStore = createPricingStore({
    cachePath: C('pricingCachePath') || defaultPricingPath(homedir(), C('namespace')),
    ttlHours: C('pricingAutoRefreshHours'),
  });

  let jev = null;
  const disposers = [];

  /**
   * 模型能力缓存：向 `llm` 服务问「这个路由支持哪些推理强度」。
   * 懒取服务，因为 apply() 时 llm 可能还没挂上。
   */
  const caps = createCapabilityCache({
    resolveModelInfo: async (provider, model) => {
      const llm = ctx.get('llm');
      if (typeof llm?.resolveModelInfo !== 'function') {
        throw new Error('llm service unavailable');
      }
      return llm.resolveModelInfo(provider, model);
    },
  });

  /**
   * 取一个路由的单价：优先用 DeepSeek 官网价目，其次用用户自备价目。
   * 自备价目让「路由到非 DeepSeek 模型」也能算清破缓存的代价，
   * 否则成本闸会一律以 no-pricing 拒绝。
   */
  async function priceForRoute(provider, model) {
    const official = priceFor(await pricingStore.current(), model, {
      holidays: C('holidays'),
    });
    if (official) return official;
    return customPriceFor(parseCustomPricing(C('customPricing')), provider, model);
  }

  function sessionFor(id) {
    const key = String(id ?? 'unknown');
    let entry = sessions.get(key);
    if (!entry) {
      entry = {
        state: createSessionState(),
        decision: null,
        pending: null,
        reasoningSum: 0,
        reasoningSteps: 0,
        previousModel: null,
        previousProvider: null,
      };
      sessions.set(key, entry);
    }
    return entry;
  }

  // ── 凭据：TypeSafe API Key ────────────────────────────────
  //
  // 解析顺序（与 DSH credentials 服务的分层一致）：
  //   继承的进程环境 > $DSH_HOME/.credentials.yaml（本页可写） > <cwd>/.env > $DSH_HOME/.env
  // 凭据名可配置（apiKeyRef），默认 TYPESAFE_API_KEY。
  async function resolveApiKey() {
    const ref = C('apiKeyRef');
    const credentials = ctx.get('credentials');
    if (credentials?.resolve) {
      try {
        const resolved = await credentials.resolve(ref);
        if (resolved?.value) return resolved.value;
      } catch {
        /* 凭据服务不可用或未配置，落到环境变量 */
      }
    }
    return process.env[ref] || process.env.TYPESAFE_API_KEY || process.env.TYPESAFE_KEY || undefined;
  }

  /** 凭据的配置状态（供设置页显示，不暴露值）。 */
  async function credentialState() {
    const ref = C('apiKeyRef');
    const credentials = ctx.get('credentials');
    if (typeof credentials?.describe !== 'function') {
      return { ref, configured: false, writable: false, source: undefined, error: '当前 host 没有 credentials 服务' };
    }
    try {
      const info = await credentials.describe(ref);
      return {
        ref,
        configured: info?.configured === true,
        writable: info?.writable === true,
        source: info?.source,
      };
    } catch (error) {
      return { ref, configured: false, writable: false, error: String(error?.message ?? error) };
    }
  }

  async function ensureJev() {
    const apiKey = await resolveApiKey();
    const timeoutMs = C('timeoutMs');
    if (!jev || jev.apiKey !== apiKey || jev.timeoutMs !== timeoutMs) {
      jev = new JevClient({ apiKey, timeoutMs });
    }
    return jev;
  }

  // ── 判定：用户消息进 inbox 时触发 ────────────────────────────
  ctx.on('agent/inbox/inserted', (payload) => {
    const agent = payload?.agent ?? payload;
    if (!agent?.id) return;
    if (C('enabled') === false) return;

    const text = extractUserText(payload?.message);
    if (!text) return;

    const entry = sessionFor(agent.id);
    const targetTurn = typeof payload?.message?.turn === 'number' ? payload.message.turn : null;

    const run = (async () => {
      const client = await ensureJev();
      const questions = buildQuestions();

      // Tier B：只有开启路由且给了白名单时才多问一个模型选择问题。
      const allowlist = Array.isArray(C('modelAllowlist')) ? C('modelAllowlist').filter(Boolean) : [];
      const routable = C('modelRouting') === true && allowlist.length > 0;
      if (routable) {
        const current = entry.state.model ?? null;
        const criteria = { keep: 'The currently selected model is adequate for this request.' };
        for (const id of allowlist) {
          criteria[id] = noteFor(id) ?? `Use model ${id} for this request.`;
        }
        if (current) criteria.keep = `Keep using ${current}; no switch needed.`;
        questions.model = {
          type: 'choice',
          instructions: 'Which model should handle this request? Prefer the cheapest model that is clearly sufficient.',
          criteria,
        };
      }

      const body = await client.ask({ user_message: text }, questions);
      let decision;
      let source;
      if (body) {
        const parsed = parseDecision(body);
        decision = parsed;
        source = `jev(${parsed.jevModel ?? 'unknown'})`;
      } else {
        const fallback = heuristicEffort(text, C('fallbackEffort'));
        decision = { effort: fallback.effort, effortConfidence: 1, risk: null, urgent: null, model: null, matched: fallback.matched };
        source = 'heuristic';
      }

      // 迟滞 / 置信度门在这里不做——留给 agent/request 的回合起点统一裁决，
      // 以免同一轮被判定多次而破坏迟滞语义。
      entry.decision = { ...decision, source, at: Date.now(), turn: targetTurn };
    })();

    entry.pending = run.catch(() => undefined);
  });

  function noteFor(modelId) {
    const notes = Array.isArray(C('modelNotes')) ? C('modelNotes') : [];
    for (const line of notes) {
      const index = String(line).indexOf(':');
      if (index <= 0) continue;
      if (String(line).slice(0, index).trim() === modelId) return String(line).slice(index + 1).trim();
    }
    return null;
  }

  // ── 核心：改写调用配置 ───────────────────────────────────────
  ctx.on('agent/request', async (payload, next) => {
    const cfg = await next();
    if (C('enabled') === false) return cfg;
    const agent = payload?.agent;
    if (!agent?.id) return cfg;
    const entry = sessionFor(agent.id);

    if (C('blockOnDecision') !== false && entry.pending) {
      try {
        await entry.pending;
      } catch {
        /* 判定失败不阻塞请求 */
      }
    }

    const replacement = { ...cfg };
    const atTurnStart = (payload?.step ?? 1) <= 1;

    // Tier A：思考强度。单轮内锁定，只在回合起点重新裁决。
    if (atTurnStart) {
      const decided = entry.decision?.effort ?? null;
      const confidence = entry.decision?.effortConfidence ?? 0;
      const verdict = decideEffort({
        state: entry.state,
        config: policyConfig(),
        decided,
        confidence,
        currentHarnessEffort: cfg.reasoningEffort,
        // 关键词回退是用户自己写下的字面指令，降档不需要连续确认。
        trusted: entry.decision?.source === 'heuristic',
      });

      // 夹取到模型真正支持的档位：DSH 对不支持的档位是硬拒绝
      // （llm 服务明确声明不做 clamping / aliasing），原样透传会让请求失败。
      const capabilities = await caps.capabilities(cfg.provider, cfg.model);
      const clamped = clampEffort(verdict.effort, capabilities.supported);

      entry.lastEffortVerdict = {
        ...verdict,
        supported: capabilities.supported ?? undefined,
        resolvable: capabilities.resolvable,
        clamp: clamped.clamped ? clamped.reason : undefined,
      };

      if (clamped.effort != null) {
        replacement.reasoningEffort = clamped.effort;
        // 记成夹取后的值，让同轮后续 step 复用时也保持一致。
        entry.state.effort = clamped.effort;
      }
      if (clamped.clamped) {
        ctx.logger?.info?.(
          `[jev-router] effort clamped for ${cfg.provider}/${cfg.model}: ${clamped.reason}`,
        );
      }
    } else if (entry.state.effort != null) {
      replacement.reasoningEffort = entry.state.effort;
    }

    // Tier B：自动模型路由（五道闸，默认关闭 + 硬门禁）。
    if (atTurnStart && C('modelRouting') === true) {
      await applyModelRouting({ agent, entry, replacement });
    }

    // 记住真实生效的路由：快照与诊断用它，而不是靠猜默认模型。
    entry.lastRoute = { provider: replacement.provider, model: replacement.model };

    return replacement;
  });

  async function applyModelRouting({ agent, entry, replacement }) {
    const rawCandidate = entry.decision?.model ?? null;
    if (!rawCandidate || rawCandidate === 'keep') {
      entry.state.pendingModel = null;
      entry.state.pendingModelStreak = 0;
      return;
    }

    // 白名单条目可以是 `model`（当前 provider）或 `provider::model`。
    const parsed = parseAllowlistEntry(rawCandidate);
    if (!parsed) {
      entry.lastModelVerdict = { allow: false, reason: 'invalid-candidate' };
      return;
    }
    const targetProvider = parsed.provider ?? replacement.provider;
    const targetModel = parsed.model;

    // 候选必须能在该 provider 上解析，否则切过去只会得到一个失败的请求。
    const capabilities = await caps.capabilities(targetProvider, targetModel);
    if (!capabilities.resolvable) {
      entry.lastModelVerdict = { allow: false, reason: 'unresolvable-candidate' };
      ctx.logger?.warn?.(
        `[jev-router] 候选模型 ${targetProvider}/${targetModel} 无法解析，拒绝切换（检查白名单写法与 provider 拼写）`,
      );
      return;
    }

    const prefixTokens = estimatePrefixTokens(metrics);
    // 破缓存的代价由**切换之后**的第一个请求承担，那时计费的是目标模型，
    // 所以成本闸必须用目标路由的价目，而不是当前路由的。
    const price = await priceForRoute(targetProvider, targetModel);
    const predicted = predictOutputSaving(averageReasoningTokens(entry));

    const verdict = shouldSwitchModel({
      state: entry.state,
      config: policyConfig(),
      candidate: targetModel,
      // 白名单按原始条目比对（条目可能是 provider::model）
      candidateKey: rawCandidate,
      candidateConfidence: entry.decision?.effortConfidence ?? 0,
      atTurnStart: true,
      prefixTokens,
      pricing: price,
      predictedOutputSavingTokens: predicted,
    });
    entry.lastModelVerdict = verdict;

    if (!verdict.allow) {
      const noteworthy = [
        'not-worth-it',
        'cache-risk-not-acknowledged',
        'no-pricing',
        'not-turn-boundary',
      ];
      if (noteworthy.includes(verdict.reason)) {
        ctx.logger?.info?.(
          `[jev-router] model switch to ${targetProvider}/${targetModel} refused: ${verdict.reason}` +
            (verdict.breakeven ? ` (breakeven ${Math.round(verdict.breakeven)} output tokens)` : '') +
            (verdict.reason === 'no-pricing'
              ? '；该模型没有已知价目，可在一目了然的 customPricing 里补一条'
              : ''),
        );
      }
      return;
    }

    entry.previousModel = replacement.model;
    entry.previousProvider = replacement.provider;
    replacement.provider = targetProvider;
    replacement.model = targetModel;
    ctx.logger?.info?.(
      `[jev-router] model switched ${entry.previousProvider}/${entry.previousModel} → ${targetProvider}/${targetModel}` +
        ` (extra cache-miss cost ≈ $${(verdict.cost ?? 0).toFixed(4)})`,
    );
    // 持久、可见地记录这次切换（与内置模型选择器同一条通道）。
    try {
      agent.session?.append?.('model/selection', {
        provider: targetProvider,
        model: targetModel,
        ...(replacement.reasoningEffort === undefined ? {} : { reasoningEffort: replacement.reasoningEffort }),
      });
    } catch {
      /* 会话不可追加时仅本次请求生效 */
    }
  }

  // ── 计量：抓每一次模型调用的 usage ───────────────────────────
  ctx.on('llm/stream', function (options, next) {
    // next() 按契约同步返回 AsyncIterable，但不同实现可能返回 thenable。
    // 这里两种都支持：await 放在 async generator 内部，既不会打断数据流，
    // 也不会在契约被破坏时静默丢掉计量。
    const innerResult = next();

    const agents = ctx.get('agents');
    let agentId;
    try {
      agentId = agents?.currentInitiator?.()?.id;
    } catch {
      agentId = undefined;
    }
    const model = options?.model;
    const provider = options?.provider;
    const effort = options?.reasoningEffort;
    // 'compaction' | 'session-title' —— 这些调用走另一套 prompt，
    // 计入会让「命中率」失去意义，因此分开计数、不进主指标。
    const purpose = options?.purpose;

    return (async function* tap() {
      const inner = await innerResult;
      if (!inner || typeof inner[Symbol.asyncIterator] !== 'function') {
        throw new Error('jev-router: llm/stream next() did not resolve to an AsyncIterable');
      }
      for await (const chunk of inner) {
        try {
          if (chunk && chunk.type === 'usage' && chunk.usage) {
            if (purpose !== undefined) {
              metrics.auxiliaryCalls += 1;
            } else {
              recordUsage(metrics, chunk.usage, { agentId, model, provider, effort });
              if (agentId) {
                const entry = sessions.get(String(agentId));
                if (entry && Number.isFinite(chunk.usage.reasoningTokens)) {
                  entry.reasoningSum += chunk.usage.reasoningTokens;
                  entry.reasoningSteps += 1;
                }
              }
            }
          }
        } catch {
          /* 计量失败绝不影响模型流 */
        }
        yield chunk;
      }
    })();
  });

  // ── 回合结束：推进迟滞计数 ───────────────────────────────────
  ctx.on('agent/turn-stopping', (payload) => {
    const agent = payload?.agent;
    if (!agent?.id) return;
    const entry = sessions.get(String(agent.id));
    if (!entry) return;
    entry.state.roundsSinceEffortChange += 1;
    entry.state.roundsSinceModelSwitch += 1;
    checkHitRateAlert(agent, entry);
  });

  function checkHitRateAlert(agent, entry) {
    const threshold = C('hitRateAlert');
    const verdict = shouldAlert({ metrics, threshold });
    if (!verdict.alert) return;
    if (entry.alertedAt && Date.now() - entry.alertedAt < 5 * 60 * 1000) return;
    entry.alertedAt = Date.now();
    ctx.logger?.warn?.(
      `[jev-router] 窗口缓存命中率 ${(verdict.hitRate * 100).toFixed(1)}% 低于阈值 ${(threshold * 100).toFixed(0)}%` +
        `${entry.previousModel ? `；模型曾在会话内切换过，可用 /jev rollback 回滚到 ${entry.previousModel}` : ''}`,
    );
  }

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent;
    if (agent?.id) sessions.delete(String(agent.id));
  });

  // ── 运行时对外接口（命令与路由共用） ─────────────────────────
  const runtime = {
    ctx,
    config: live,
    author: AUTHOR,

    status(agent) {
      const entry = agent?.id ? sessions.get(String(agent.id)) : null;
      return {
        enabled: C('enabled') !== false,
        effort: entry?.state?.effort ?? (C('effort') && C('effort') !== 'auto' ? C('effort') : null),
        decided: entry?.decision?.effort ?? null,
        decidedSource: entry?.decision?.source ?? null,
        confidence: entry?.decision?.effortConfidence ?? null,
        modelRouting: C('modelRouting') === true,
        acknowledgeCacheRisk: C('acknowledgeCacheRisk') === true,
        model: entry?.state?.model ?? null,
        previousModel: entry?.previousModel ?? null,
        switches: entry?.state?.switches ?? 0,
      };
    },

    currentEffort(agent) {
      const entry = agent?.id ? sessions.get(String(agent.id)) : null;
      return entry?.state?.effort ?? null;
    },

    async snapshotForClient(agent) {
      const entry = agent?.id ? sessions.get(String(agent.id)) : null;
      const pricing = await pricingStore.current();
      const currentProvider = entry?.lastRoute?.provider;
      const currentModel = entry?.lastRoute?.model ?? entry?.state?.model ?? undefined;
      const price = await priceForRoute(currentProvider, currentModel);
      const stats = snapshot(metrics, price);
      const lastEffort = entry?.lastEffortVerdict ?? null;
      const lastModel = entry?.lastModelVerdict ?? null;
      return {
        author: AUTHOR,
        authorUrl: AUTHOR_URL,
        version: '0.1.0',
        credential: await credentialState(),
        config: {
          enabled: C('enabled') !== false,
          effort: C('effort'),
          modelRouting: C('modelRouting') === true,
          acknowledgeCacheRisk: C('acknowledgeCacheRisk') === true,
          hitRateAlert: C('hitRateAlert'),
          showBadge: C('showBadge') !== false,
        },
        session: {
          effort: entry?.state?.effort ?? null,
          decided: entry?.decision?.effort ?? null,
          source: entry?.decision?.source ?? null,
          confidence: entry?.decision?.effortConfidence ?? null,
          risk: entry?.decision?.risk ?? null,
          urgent: entry?.decision?.urgent ?? null,
          model: entry?.lastRoute?.model ?? entry?.state?.model ?? null,
          provider: entry?.lastRoute?.provider ?? null,
          previousModel: entry?.previousModel ?? null,
          previousProvider: entry?.previousProvider ?? null,
          switches: entry?.state?.switches ?? 0,
          lastEffortVerdict: lastEffort,
          lastModelVerdict: lastModel,
        },
        metrics: {
          steps: stats.steps,
          hitRate: stats.hitRate,
          windowHitRate: stats.windowHitRate,
          inputTokens: stats.inputTokens,
          cacheReadTokens: stats.cacheReadTokens,
          outputTokens: stats.outputTokens,
          reasoningTokens: stats.reasoningTokens,
          reasoningShare: stats.reasoningShare,
          reasoningReported: stats.reasoningReported,
          cacheSavingUsd: stats.cacheSavingUsd,
          avgReasoningTokens: stats.avgReasoningTokens,
          auxiliaryCalls: stats.auxiliaryCalls,
        },
        pricing: {
          source: price?.period === 'custom' ? 'custom' : (pricing.source ?? 'unknown'),
          fetchedAt: pricing.fetchedAt ?? null,
          url: pricing.url ?? null,
          period: price?.period ?? null,
          model: price?.model ?? null,
          hit: price?.hit ?? null,
          miss: price?.miss ?? null,
          out: price?.out ?? null,
          breakevenOutputTokens:
            price && currentModel
              ? breakevenOutputTokens({
                  prefixTokens: estimatePrefixTokens(metrics),
                  hit: price.hit,
                  miss: price.miss,
                  out: price.out,
                })
              : null,
          switchCostUsd: price ? estimateSwitchCost({
            prefixTokens: estimatePrefixTokens(metrics),
            hit: price.hit,
            miss: price.miss,
          }) : null,
        },
      };
    },

    describeStatus(agent) {
      const status = runtime.status(agent);
      const stats = snapshot(metrics, null);
      const lines = [
        `dsh-jev-router · 作者 ${AUTHOR}`,
        `总开关：${status.enabled ? '开' : '关'}`,
        `思考强度：${status.effort ?? 'harness 默认'}${status.decided ? `（Jev 判定 ${status.decided}，来源 ${status.decidedSource ?? '—'}，置信度 ${status.confidence ?? '—'}）` : ''}`,
        `自动模型路由：${status.modelRouting ? '开' : '关（默认）'} · 缓存风险已确认：${status.acknowledgeCacheRisk ? '是' : '否'}`,
      ];
      if (status.model) lines.push(`当前模型：${status.model}${status.previousModel ? `（可回滚到 ${status.previousModel}）` : ''}`);
      lines.push(
        `缓存命中率：${stats.hitRate === null ? '—' : `${(stats.hitRate * 100).toFixed(2)}%`}` +
          `（近 ${stats.windowSteps} 步 ${stats.windowHitRate === null ? '—' : `${(stats.windowHitRate * 100).toFixed(2)}%`}）`,
        `累计：命中 ${stats.cacheReadTokens.toLocaleString()} / 未命中 ${stats.inputTokens.toLocaleString()} tokens`,
        `reasoning 占输出：${stats.reasoningShare === null ? '—' : `${(stats.reasoningShare * 100).toFixed(1)}%`}`,
      );
      return lines.join('\n');
    },

    explain(agent) {
      const entry = agent?.id ? sessions.get(String(agent.id)) : null;
      if (!entry?.decision) return '本轮还没有判定结果（Jev 未配置或尚未收到消息）。';
      const d = entry.decision;
      const lines = [
        `来源：${d.source ?? '—'}`,
        `档位：${d.effort ?? '—'}（置信度 ${d.effortConfidence ?? '—'}）`,
        d.risk === null || d.risk === undefined ? null : `错误代价（score 0-3）：${d.risk}`,
        d.urgent === null || d.urgent === undefined ? null : `用户想要快答（noul 0-1）：${d.urgent}`,
        d.matched ? `关键词命中：${d.matched}` : null,
        entry.lastEffortVerdict
          ? `策略裁决：${entry.lastEffortVerdict.reason} → ${entry.lastEffortVerdict.effort}` +
            (entry.lastEffortVerdict.clamp ? `（已夹取：${entry.lastEffortVerdict.clamp}）` : '') +
            (entry.lastEffortVerdict.supported ? ` · 该模型支持 ${entry.lastEffortVerdict.supported.join('/')}` : ' · 该模型未声明推理档位')
          : null,
        entry.lastModelVerdict ? `模型闸门：${entry.lastModelVerdict.reason}` : null,
      ].filter(Boolean);
      return lines.join('\n');
    },

    async setConfig(patch) {
      const settings = ctx.get('settings');
      const ns = C('namespace');
      if (settings?.update) {
        try {
          await settings.update(ns, patch);
        } catch (error) {
          return {
            ok: false,
            reason: `写入设置失败（namespace=${ns}）：${String(error?.message ?? error)}。可在「设置 → 插件」里直接修改。`,
          };
        }
      } else {
        return { ok: false, reason: '当前 host 没有 settings 服务，请在「设置 → 插件」中修改。' };
      }
      Object.assign(live, patch);
      return { ok: true, patch };
    },

    async credentialState() {
      return credentialState();
    },

    /** 写入凭据。密钥只进凭据存储，绝不写进 profile 配置。 */
    async setCredential(value) {
      const ref = C('apiKeyRef');
      const credentials = ctx.get('credentials');
      if (typeof credentials?.set !== 'function') {
        return { ok: false, reason: '当前 host 没有 credentials 服务，无法写入；可改用 $DSH_HOME/.env' };
      }
      const secret = typeof value === 'string' ? value.trim() : '';
      if (secret.length === 0) return { ok: false, reason: 'Key 不能为空' };
      try {
        await credentials.set(ref, secret);
      } catch (error) {
        // 常见原因：继承的进程环境里已有同名变量，只读层遮蔽了可写层。
        return { ok: false, reason: String(error?.message ?? error) };
      }
      // 立即生效：ensureJev 每次都会重新解析凭据。
      jev = null;
      return { ok: true, state: await credentialState() };
    },

    /** 清除凭据。 */
    async clearCredential() {
      const ref = C('apiKeyRef');
      const credentials = ctx.get('credentials');
      if (typeof credentials?.unset !== 'function') {
        return { ok: false, reason: '当前 host 没有 credentials 服务' };
      }
      try {
        await credentials.unset(ref);
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error) };
      }
      jev = null;
      return { ok: true, state: await credentialState() };
    },

    async refreshPricing() {
      const result = await pricingStore.refresh();
      if (result.ok) {
        return { ok: true, models: Object.keys(result.pricing.models ?? {}).length, pricing: result.pricing };
      }
      return {
        ok: false,
        reason: result.reason,
        fallback: result.pricing?.source === 'snapshot' ? '内置快照' : '既有缓存',
      };
    },

    describePricing() {
      const pricing = pricingStore;
      return pricing.current().then((value) => {
        const models = Object.keys(value.models ?? {});
        const lines = [
          `价目来源：${value.source ?? 'unknown'}（${value.fetchedAt ?? '—'}）`,
          `官网：${value.url ?? 'https://api-docs.deepseek.com/quick_start/pricing'}`,
          ...models.map((key) => {
            const entry = value.models[key];
            return `  ${key}: hit ${entry.hit.offpeak}/${entry.hit.peak} · miss ${entry.miss.offpeak}/${entry.miss.peak} · out ${entry.out.offpeak}/${entry.out.peak}（off-peak/peak，$/M）`;
          }),
          '内置快照模型：' + Object.keys(SNAPSHOT.models).join(', '),
        ];
        return lines.join('\n');
      });
    },

    rollback(agent) {
      const entry = agent?.id ? sessions.get(String(agent.id)) : null;
      if (!entry?.previousModel) return { ok: false, reason: '没有可回滚的模型切换记录。' };
      const to = entry.previousModel;
      const from = entry.state.model;
      const toProvider = entry.previousProvider ?? undefined;
      entry.previousModel = null;
      entry.previousProvider = null;
      entry.state.model = to;
      entry.state.history.push({ kind: 'model', to, from, reason: 'rollback', at: Date.now() });
      try {
        agent.session?.append?.('model/selection', {
          ...(toProvider === undefined ? {} : { provider: toProvider }),
          model: to,
        });
      } catch {
        /* 忽略 */
      }
      return { ok: true, to, from };
    },
  };

  // ── 接线 ─────────────────────────────────────────────────────
  ctx.inject(['commands'], (scoped) => {
    disposers.push(registerCommands(scoped, runtime));
  });

  ctx.inject(['webServer'], (scoped) => {
    disposers.push(registerRoutes(scoped, runtime));
  });

  const settingsResult = installSettings(ctx);
  if (!settingsResult.installed) {
    ctx.logger?.warn?.(`[jev-router] 设置页未接线：${settingsResult.reason ?? 'unknown'}`);
  }

  // 价目预热：启动时取一次，之后按 TTL 自动刷新。
  void (async () => {
    try {
      const store = pricingStore;
      if (await store.stale()) await store.refresh();
    } catch {
      /* 价格失败不影响插件 */
    }
  })();

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.();
      } catch {
        /* 忽略 */
      }
    }
    sessions.clear();
  }, 'dsh-jev-router: teardown');
}

// ── 辅助 ──────────────────────────────────────────────────────

function averageReasoningTokens(entry) {
  if (!entry || entry.reasoningSteps === 0) return 0;
  return entry.reasoningSum / entry.reasoningSteps;
}

/**
 * 估算当前会话前缀长度。
 *
 * 用「最近一步的 input + cacheRead」作为前缀规模的上界近似：
 * 这是当前上下文实际发出去的 token 数，正是破缓存时要重新 prefill 的量。
 */
function estimatePrefixTokens(metrics) {
  const last = metrics.lastStep;
  if (!last) return 0;
  return (last.inputTokens ?? 0) + (last.cacheReadTokens ?? 0);
}

export const __test__ = { estimatePrefixTokens, averageReasoningTokens, EFFORTS };
