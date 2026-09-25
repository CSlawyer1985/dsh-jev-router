/**
 * Host 半集成测试：用假的 Cordis 上下文把插件真正挂起来，跑通整条链路。
 *
 * 这组测试的价值在于：它验证的是「重启之后会不会真的好用」，
 * 而不是单个纯函数。覆盖：
 *   - agent/inbox/inserted → Jev 判定 → agent/request 改写配置
 *   - 改写只碰 reasoningEffort，messages 原样保留（缓存安全的核心不变量）
 *   - HTTP 路由（含 async 必须 await 的回归）
 *   - 设置写入用的 namespace 正确
 *   - Jev 不可用时的启发式回退
 *   - 硬门禁：未确认缓存风险时不改模型
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 构造一个够用的假 Cordis 上下文与宿主服务。 */
function createFakeHost(
  configOverrides = {},
  { apiKey, initiatorId, llmRoutes, llmContextWindows, volatileConfig = false } = {},
) {
  const listeners = new Map();
  const effects = [];
  const registeredRoutes = new Map();
  const registeredCommands = new Map();
  const settingsUpdates = [];
  const credentialWrites = [];
  const logs = [];

  const config = {
    enabled: true,
    effort: 'auto',
    confidenceFloor: 0.5,
    fallbackEffort: 'high',
    hysteresisRounds: 2,
    downgradeStreak: 2,
    riskCeiling: 0.6,
    syncSessionEffort: true,
    offFloorChars: 280,
    timeoutMs: 1500,
    blockOnDecision: true,
    modelRouting: false,
    acknowledgeCacheRisk: false,
    modelSwitchMode: 'turn-boundary',
    modelAllowlist: [],
    modelNotes: [],
    customPricing: [],
    stickyRounds: 3,
    switchCooldown: 2,
    maxSwitchesPerSession: 2,
    hitRateAlert: 0.8,
    skillRouting: false,
    pricingAutoRefreshHours: 24,
    // 用临时目录，避免读到开发机上的真实缓存
    pricingCachePath: join(mkdtempSync(join(tmpdir(), 'jev-test-')), 'pricing.json'),
    holidays: [],
    showBadge: true,
    namespace: 'jev-router',
    apiKeyRef: 'TYPESAFE_API_KEY',
    ...configOverrides,
  };

  // 真实宿主把 volatile 字段作为引用对象交给插件；volatileConfig 复刻这一形态。
  // 与 cosmokit 一致：带 get 与 write 符号，且 settings.update 会通过 write 更新它。
  const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
  const deliveredConfig = volatileConfig
    ? Object.fromEntries(
        Object.entries(config).map(([key, value]) => {
          let current = value;
          return [key, Object.freeze({ get: () => current, [VOLATILE_WRITE]: (v) => { current = v; } })];
        }),
      )
    : config;

  // 服务必须是**单例**：每次 ctx.get 都新建会把 set 写进一个随即被丢弃的闭包。
  const credentialStore = { value: apiKey };
  const credentialsService = {
    resolve: async () => (credentialStore.value ? { value: credentialStore.value } : undefined),
    describe: async () => ({
      configured: Boolean(credentialStore.value),
      writable: true,
      ...(credentialStore.value ? { source: 'store' } : {}),
    }),
    set: async (_ref, value) => {
      credentialStore.value = value;
      credentialWrites.push({ op: 'set', value });
    },
    unset: async () => {
      credentialStore.value = undefined;
      credentialWrites.push({ op: 'unset' });
    },
  };

  const ctx = {
    logger: {
      info: (m) => logs.push(['info', String(m)]),
      warn: (m) => logs.push(['warn', String(m)]),
    },
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
      return () => {};
    },
    get(name) {
      if (name === 'settings') {
        return {
          configure: () => () => {},
          update: async (ns, patch) => {
            settingsUpdates.push({ ns, patch });
            // 模拟 DSH：settings.update 会通过 write 符号把值写回 volatile 引用，
            // 于是插件的 readConfig 每次 .get() 都读到最新值。
            for (const [key, value] of Object.entries(patch)) {
              const w = deliveredConfig[key];
              const write = w && w[Symbol.for('cosmokit.volatile.write')];
              if (typeof write === 'function') write(value);
            }
          },
        };
      }
      if (name === 'credentials') return credentialsService;
      if (name === 'llm') {
        const ctxWin = (provider, model) =>
          llmContextWindows === undefined ? undefined : llmContextWindows[`${provider}::${model}`];
        // 真实宿主一定提供 llm：插件靠它问「这个路由支持哪些推理强度」，
        // 因为 DSH 对不支持的档位是硬拒绝（不做 clamping）。
        return {
          resolveModelInfo: async (provider, model) => {
            const key = `${provider}::${model}`;
            if (llmRoutes !== undefined) {
              if (!Object.prototype.hasOwnProperty.call(llmRoutes, key)) {
                throw new Error(`unknown route ${key}`);
              }
              const efforts = llmRoutes[key];
              const win = ctxWin(provider, model);
              return {
                provider,
                id: model,
                name: model,
                reasoning: efforts === null ? undefined : { efforts: efforts.map((id) => ({ id, name: id })) },
                ...(win === undefined ? {} : { context: { contextWindow: win } }),
              };
            }
            return {
              provider,
              id: model,
              name: model,
              reasoning: { efforts: ['off', 'low', 'high', 'max'].map((id) => ({ id, name: id })) },
            };
          },
        };
      }
      if (name === 'agents') {
        return {
          list: () => [],
          // 真实运行时这里返回正在跑的 Agent（withInitiator 的作用）；
          // 计量归属依赖它，所以夹具必须能模拟。
          currentInitiator: () => (initiatorId ? { id: initiatorId } : undefined),
        };
      }
      return undefined;
    },
    inject(_deps, callback) {
      callback(ctx);
    },
    effect(callback, label) {
      const disposer = callback();
      effects.push({ disposer, label });
      return () => {};
    },
  };

  const services = {
    commands: {
      register(definition) {
        registeredCommands.set(definition.name, definition);
        return () => registeredCommands.delete(definition.name);
      },
    },
    webServer: {
      register(route) {
        registeredRoutes.set(route.path, route);
        return () => registeredRoutes.delete(route.path);
      },
    },
  };

  // commands / webServer 通过 ctx.get 取用
  const originalGet = ctx.get;
  ctx.get = (name) => services[name] ?? originalGet(name);

  return {
    ctx,
    config: deliveredConfig,
    rawConfig: config,
    listeners,
    registeredRoutes,
    registeredCommands,
    settingsUpdates,
    credentialWrites,
    logs,
  };
}

/** 触发一个 emit 型事件的全部监听器。 */
function emit(host, name, payload) {
  for (const handler of host.listeners.get(name) ?? []) handler(payload);
}

/**
 * 触发一个 waterfall 型事件。
 *
 * `next` 必须是**同步**的：Cordis 对 `llm/stream` 声明的 next 返回
 * AsyncIterable 而非 Promise。这里同步返回各阶段的原始返回值，
 * 由调用方决定是否 await（agent/request 返回 Promise，llm/stream 返回可迭代对象）。
 */
async function waterfall(host, name, payload, produce) {
  const chain = host.listeners.get(name) ?? [];
  let index = -1;
  const next = () => {
    index += 1;
    if (index < chain.length) return chain[index](payload, next);
    return produce();
  };
  return next();
}

/** 假的 HTTP 请求：按需吐出 JSON body。 */
function fakeRequest({ method = 'GET', body, headers = {}, url } = {}) {
  const handlers = new Map();
  const request = {
    method,
    headers,
    // 路由会读 request.url 上的 query（?session=<id>），桩必须把它带出来，
    // 否则测试永远走 fallback 分支，测不出多会话串号。
    url,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return request;
    },
    destroy() {},
  };
  // 在下一个 tick 里推数据，让 handler 有时间挂上监听
  queueMicrotask(() => {
    if (body !== undefined) {
      for (const handler of handlers.get('data') ?? []) handler(Buffer.from(body));
    }
    for (const handler of handlers.get('end') ?? []) handler();
  });
  return request;
}

/** 假的 HTTP 响应：捕获状态码、头部与 body。 */
function fakeResponse() {
  const captured = { status: undefined, headers: undefined, body: undefined };
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(payload) {
      captured.body = payload;
    },
  };
}

/** 安装 Jev / 价目的 fetch 替身。 */
function stubFetch({ jevBody, jevOk = true } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, options });
    if (target.includes('api-docs.deepseek.com')) {
      // 让价目刷新失败，测试走快照回退路径（不打真实网络）
      return { ok: false, status: 503, text: async () => '', headers: { get: () => null } };
    }
    if (target.includes('api.typesafe.ai')) {
      return {
        ok: jevOk,
        status: jevOk ? 200 : 500,
        headers: { get: () => null },
        // jevBody 可以是函数：按调用次序返回不同响应（模拟不同会话的判定）。
        json: async () => (typeof jevBody === 'function' ? jevBody() : jevBody),
      };
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const API_KEY = 'test-typesafe-key';

/** 构造一个指定档位的 Jev 响应（用于测降档的连续确认）。 */
function jevWithEffort(effort, confidence = 0.9, risk = 1) {
  return {
    model: 'jev-1.13.0',
    answers: {
      effort: { type: 'choice', choice: effort, probabilities: { [effort]: confidence }, confidence },
      risk: { type: 'score', score: risk, probabilities: {}, confidence: 0.9 },
      urgent: { type: 'noul', noul: 0.5 },
      model: { type: 'choice', choice: 'keep', probabilities: { keep: 1 }, confidence: 0.9 },
    },
    usage: {},
  };
}

/** 构造一个把模型路由目标指定为 choice 的 Jev 响应。 */
function jevChoosing(choice) {
  return {
    model: 'jev-1.13.0',
    answers: {
      effort: { type: 'choice', choice: 'max', probabilities: { max: 0.9 }, confidence: 0.9 },
      risk: { type: 'score', score: 3, probabilities: {}, confidence: 0.9 },
      urgent: { type: 'noul', noul: 0.1 },
      model: { type: 'choice', choice, probabilities: { [choice]: 0.95 }, confidence: 0.95 },
    },
    usage: { input_tokens: 120, output_tokens: 20 },
  };
}

const JEV_MAX = {
  model: 'jev-1.13.0',
  answers: {
    effort: { type: 'choice', choice: 'max', probabilities: { max: 0.9 }, confidence: 0.9 },
    risk: { type: 'score', score: 3, probabilities: {}, confidence: 0.9 },
    urgent: { type: 'noul', noul: 0.1 },
    model: { type: 'choice', choice: 'deepseek-v4-pro', probabilities: { 'deepseek-v4-pro': 0.95 }, confidence: 0.95 },
  },
  usage: { input_tokens: 120, output_tokens: 20 },
};

/** 加载插件并挂载到假宿主上。 */
async function mount(configOverrides = {}, options = {}) {
  const host = createFakeHost(configOverrides, options);
  const mod = await import('../lib/index.js');
  mod.apply(host.ctx, host.config);
  return { host, mod };
}

// ── 端到端：判定 → 改写调用配置 ───────────────────────────────
test('集成：Jev 判定出的档位被写进 agent/request 的返回配置', async () => {
  const fetchStub = stubFetch({ jevBody: JEV_MAX });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });

    emit(host, 'agent/inbox/inserted', {
      agent: { id: 's1' },
      message: { content: [{ type: 'text', text: '帮我彻底重构这个模块的架构' }] },
    });

    const baseConfig = {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      maxTokens: 256000,
    };
    const result = await waterfall(host, 'agent/request', { agent: { id: 's1' }, turn: 1, step: 1 }, async () => baseConfig);

    assert.equal(result.reasoningEffort, 'max', 'Jev 判 max → 请求配置应为 max');
    assert.equal(result.model, 'deepseek-v4-flash', 'Tier B 关闭时模型必须原样不动');
    assert.equal(result.provider, 'deepseek-official');
  } finally {
    fetchStub.restore();
  }
});

test('集成：改写只碰 reasoningEffort，messages 必须逐字节不变（缓存安全红线）', async () => {
  const fetchStub = stubFetch({ jevBody: JEV_MAX });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });

    emit(host, 'agent/inbox/inserted', {
      agent: { id: 's2' },
      message: { content: '帮我彻底重构这个模块的架构' },
    });

    const messages = [
      { role: 'user', content: [{ type: 'text', text: '历史消息' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '历史推理', signature: 'sig-abc' }] },
    ];
    const baseConfig = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high', messages };
    const result = await waterfall(host, 'agent/request', { agent: { id: 's2' }, turn: 1, step: 1 }, async () => baseConfig);

    assert.deepEqual(result.messages, messages, 'messages 必须原样传递 —— 否则前缀缓存全灭');
    assert.equal(result.messages[1].content[0].signature, 'sig-abc', 'thinking 签名不得被剥掉');
  } finally {
    fetchStub.restore();
  }
});

test('集成：同一轮内的后续 step 复用判定结果，不重新裁决', async () => {
  const fetchStub = stubFetch({ jevBody: JEV_MAX });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });
    emit(host, 'agent/inbox/inserted', { agent: { id: 's3' }, message: { content: '彻底重构' } });

    const produce = async () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' });
    const first = await waterfall(host, 'agent/request', { agent: { id: 's3' }, turn: 1, step: 1 }, produce);
    const second = await waterfall(host, 'agent/request', { agent: { id: 's3' }, turn: 1, step: 2 }, produce);

    assert.equal(first.reasoningEffort, 'max');
    assert.equal(second.reasoningEffort, 'max', '同轮第 2 步应沿用，不应回落到 harness 默认');
  } finally {
    fetchStub.restore();
  }
});

// ── 回退与硬门禁 ────────────────────────────────────────────
test('集成：Jev 不可用时回落到关键词表，且不得阻塞请求', async () => {
  const fetchStub = stubFetch({ jevOk: false, jevBody: {} });
  try {
    const { host } = await mount({ fallbackEffort: 'high' });
    emit(host, 'agent/inbox/inserted', { agent: { id: 's4' }, message: { content: '请 ultrathink 这个设计' } });

    const result = await waterfall(
      host,
      'agent/request',
      { agent: { id: 's4' }, turn: 1, step: 1 },
      async () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }),
    );
    assert.equal(result.reasoningEffort, 'max', '关键词 ultrathink → max');
  } finally {
    fetchStub.restore();
  }
});

test('集成：没有 API Key 时走启发式，不发起网络请求', async () => {
  const fetchStub = stubFetch({ jevBody: JEV_MAX });
  try {
    const { host } = await mount();
    emit(host, 'agent/inbox/inserted', { agent: { id: 's5' }, message: { content: '请快速回答，今天几号' } });

    const result = await waterfall(
      host,
      'agent/request',
      { agent: { id: 's5' }, turn: 1, step: 1 },
      async () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' }),
    );
    assert.equal(result.reasoningEffort, 'low', '快速意图 → low');
    assert.equal(fetchStub.calls.filter((c) => c.url.includes('typesafe')).length, 0, '未配置 Key 时不应调用 Jev');
  } finally {
    fetchStub.restore();
  }
});

test('集成：Tier B 开启但未确认缓存风险 → 绝不改模型（硬门禁）', async () => {
  const fetchStub = stubFetch({ jevBody: JEV_MAX });
  try {
    const { host } = await mount(
      {
        modelRouting: true,
        acknowledgeCacheRisk: false, // ← 关键：未确认
        modelAllowlist: ['deepseek-v4-pro'],
        stickyRounds: 1,
      },
      { apiKey: API_KEY },
    );
    emit(host, 'agent/inbox/inserted', { agent: { id: 's6' }, message: { content: '彻底重构' } });

    const result = await waterfall(
      host,
      'agent/request',
      { agent: { id: 's6' }, turn: 1, step: 1 },
      async () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }),
    );
    assert.equal(result.model, 'deepseek-v4-flash', '未确认缓存风险时模型必须锁定');
    assert.ok(
      host.logs.some(([level, message]) => level === 'info' && message.includes('cache-risk-not-acknowledged')),
      '拒绝原因必须被记录，便于审计',
    );
  } finally {
    fetchStub.restore();
  }
});

test('集成：Tier B 全部条件满足时真的会切模型', async () => {
  const fetchStub = stubFetch({ jevBody: JEV_MAX });
  try {
    const { host } = await mount(
      {
        modelRouting: true,
        acknowledgeCacheRisk: true,
        modelAllowlist: ['deepseek-v4-pro'],
        stickyRounds: 1,
        switchCooldown: 0,
      },
      { apiKey: API_KEY, initiatorId: 's7' },
    );

    // 1) 先建会话条目（判定会在这一步发起）
    emit(host, 'agent/inbox/inserted', { agent: { id: 's7' }, message: { content: '彻底重构' } });

    // 2) 记一步贵的历史：极小前缀 + 大 reasoning，让成本闸算出「值得切」
    const stream = await waterfall(host, 'llm/stream', { model: 'deepseek-v4-flash' }, () =>
      (async function* () {
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 6000, cacheReadTokens: 0, reasoningTokens: 6000 } };
      })(),
    );
    for await (const _chunk of stream) { /* 消费掉 */ }

    // 3) 请求进来：应当既切模型、又改强度
    const result = await waterfall(
      host,
      'agent/request',
      { agent: { id: 's7' }, turn: 1, step: 1 },
      async () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }),
    );

    assert.equal(result.model, 'deepseek-v4-pro', '条件齐备时应当切换到候选模型');
    assert.equal(result.reasoningEffort, 'max', '思考强度与模型路由互不干扰');
  } finally {
    fetchStub.restore();
  }
});

// ── HTTP 路由 ───────────────────────────────────────────────
test('集成：GET /jev-router/status 返回完整快照（async await 回归）', async () => {
  const { host } = await mount();
  const route = host.registeredRoutes.get('/jev-router/status');
  assert.ok(route, '状态路由必须已注册');

  const response = fakeResponse();
  await route.handler(fakeRequest({ method: 'GET' }), response);

  assert.equal(response.captured.status, 200);
  const body = JSON.parse(response.captured.body);
  assert.notDeepEqual(body, {}, '曾经因为未 await 而返回 {}');
  assert.equal(body.author, 'chenshi.ai');
  assert.ok(body.config, '必须带 config 快照');
  assert.ok(body.metrics, '必须带度量快照');
  assert.ok(body.pricing, '必须带价目快照');
  assert.equal(typeof body.metrics.hitRate !== 'undefined', true);
});

test('集成：POST /jev-router/config 用正确的 namespace 写设置', async () => {
  const { host } = await mount();
  const route = host.registeredRoutes.get('/jev-router/config');
  const response = fakeResponse();

  await route.handler(
    fakeRequest({ method: 'POST', body: JSON.stringify({ patch: { effort: 'low' } }), headers: {} }),
    response,
  );

  assert.equal(response.captured.status, 200);
  assert.deepEqual(JSON.parse(response.captured.body), { ok: true, patch: { effort: 'low' } });
  assert.equal(host.settingsUpdates.length, 1);
  assert.equal(host.settingsUpdates[0].ns, 'jev-router', 'namespace 必须等于 loader entry id');
});

test('集成：POST /jev-router/config 拒绝跨站来源', async () => {
  const { host } = await mount();
  const route = host.registeredRoutes.get('/jev-router/config');
  const response = fakeResponse();

  await route.handler(
    fakeRequest({
      method: 'POST',
      body: JSON.stringify({ patch: {} }),
      headers: { origin: 'https://evil.example', host: '127.0.0.1:19387' },
    }),
    response,
  );

  assert.equal(response.captured.status, 403);
  assert.equal(host.settingsUpdates.length, 0, '跨站请求不得产生写操作');
});

test('集成：五类路由全部注册', async () => {
  const { host } = await mount();
  const paths = [...host.registeredRoutes.keys()].sort();
  assert.deepEqual(paths, [
    '/jev-router/config',
    '/jev-router/credential',
    '/jev-router/pricing/refresh',
    '/jev-router/status',
    '/jev-router/test',
  ]);
});

// ── Jev API Key 配置 ────────────────────────────────────────
test('集成：写入 Jev Key 走凭据存储，不写进 profile 配置', async () => {
  const { host } = await mount();
  const route = host.registeredRoutes.get('/jev-router/credential');
  const response = fakeResponse();

  await route.handler(
    fakeRequest({ method: 'POST', body: JSON.stringify({ value: 'ts_secret_key' }), headers: {} }),
    response,
  );

  assert.equal(response.captured.status, 200);
  const body = JSON.parse(response.captured.body);
  assert.equal(body.ok, true);
  assert.equal(body.state.configured, true, '写完应当报「已配置」');
  assert.deepEqual(host.credentialWrites, [{ op: 'set', value: 'ts_secret_key' }]);
  assert.equal(host.settingsUpdates.length, 0, 'Key 绝不能经 settings 写进 profile 配置');
});

test('集成：清除 Jev Key', async () => {
  const { host } = await mount();
  const route = host.registeredRoutes.get('/jev-router/credential');
  const response = fakeResponse();

  await route.handler(
    fakeRequest({ method: 'POST', body: JSON.stringify({ clear: true }), headers: {} }),
    response,
  );

  assert.equal(JSON.parse(response.captured.body).ok, true);
  assert.deepEqual(host.credentialWrites, [{ op: 'unset' }]);
});

test('集成：空 Key 被拒绝', async () => {
  const { host } = await mount();
  const route = host.registeredRoutes.get('/jev-router/credential');
  const response = fakeResponse();

  await route.handler(
    fakeRequest({ method: 'POST', body: JSON.stringify({ value: '   ' }), headers: {} }),
    response,
  );

  assert.equal(response.captured.status, 409);
  assert.equal(JSON.parse(response.captured.body).ok, false);
  assert.equal(host.credentialWrites.length, 0);
});

test('集成：写 Key 的接口拒绝跨站来源', async () => {
  const { host } = await mount();
  const route = host.registeredRoutes.get('/jev-router/credential');
  const response = fakeResponse();

  await route.handler(
    fakeRequest({
      method: 'POST',
      body: JSON.stringify({ value: 'x' }),
      headers: { origin: 'https://evil.example', host: '127.0.0.1:19387' },
    }),
    response,
  );

  assert.equal(response.captured.status, 403);
  assert.equal(host.credentialWrites.length, 0, '跨站请求不得写入凭据');
});

test('集成：状态快照带上凭据配置状态（不暴露值）', async () => {
  const { host } = await mount({}, { apiKey: 'secret-value' });
  const route = host.registeredRoutes.get('/jev-router/status');
  const response = fakeResponse();
  await route.handler(fakeRequest({ method: 'GET' }), response);

  const body = JSON.parse(response.captured.body);
  assert.equal(body.credential.ref, 'TYPESAFE_API_KEY');
  assert.equal(body.credential.configured, true);
  assert.ok(!response.captured.body.includes('secret-value'), '快照绝不能包含 Key 本体');
});

// ── 命令族 ──────────────────────────────────────────────────
test('集成：/jev 命令已注册，且各子命令都有输出', async () => {
  const fetchStub = stubFetch({ jevBody: JEV_MAX });
  try {
    const { host } = await mount();
    const command = host.registeredCommands.get('jev');
    assert.ok(command, '/jev 命令必须已注册');

    const invoke = (rawInput) => command.handler({ agent: { id: 'cmd-1' }, rawInput, attachments: [], signal: undefined });

    const status = await invoke('');
    assert.equal(status.kind, 'success');
    assert.match(status.text, /dsh-jev-router/);

    const about = await invoke('about');
    assert.equal(about.kind, 'success');
    assert.match(about.text, /chenshi\.ai/);

    const bad = await invoke('effort nonsense');
    assert.equal(bad.kind, 'error');
    assert.match(bad.text, /不认识/);

    const effort = await invoke('effort low');
    assert.equal(effort.kind, 'success');
    assert.equal(host.settingsUpdates.at(-1).patch.effort, 'low');

    const help = await invoke('wat');
    assert.equal(help.kind, 'error');
    assert.match(help.text, /命令用法/);
  } finally {
    fetchStub.restore();
  }
});

// ── 计量 ────────────────────────────────────────────────────
test('集成：llm/stream 的 usage 被计入命中率，且不干扰数据流', async () => {
  const { host } = await mount();

  const chunks = [
    { type: 'text', text: 'hi' },
    { type: 'usage', usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 99000, reasoningTokens: 150 } },
    { type: 'done' },
  ];
  const produce = () => (async function* () { for (const chunk of chunks) yield chunk; })();

  const stream = await waterfall(host, 'llm/stream', { model: 'deepseek-v4-flash', provider: 'deepseek-official' }, produce);
  const seen = [];
  for await (const chunk of stream) seen.push(chunk);

  assert.deepEqual(seen, chunks, '数据流必须原样透传');

  const route = host.registeredRoutes.get('/jev-router/status');
  const response = fakeResponse();
  await route.handler(fakeRequest({ method: 'GET' }), response);
  const body = JSON.parse(response.captured.body);

  assert.equal(body.metrics.steps, 1);
  assert.equal(body.metrics.cacheReadTokens, 99000);
  assert.equal(body.metrics.inputTokens, 1000);
  assert.ok(Math.abs(body.metrics.hitRate - 99000 / 100000) < 1e-9, '命中率应由真实 usage 算出');
  assert.equal(body.metrics.reasoningTokens, 150);
});

// ── 模型能力适配（本轮新增） ────────────────────────────────
test('集成：模型只支持 minimal|low|medium|high 时，max 被夹取到 high', async () => {
  const fetchStub = stubFetch({ jevBody: JEV_MAX });
  try {
    const { host } = await mount(
      { modelAllowlist: [] },
      {
        apiKey: API_KEY,
        llmRoutes: {
          'deepseek-official::deepseek-v4-flash': ['minimal', 'low', 'medium', 'high'],
        },
      },
    );
    emit(host, 'agent/inbox/inserted', { agent: { id: 'cap-1' }, message: { content: '彻底重构' } });

    const result = await waterfall(
      host,
      'agent/request',
      { agent: { id: 'cap-1' }, turn: 1, step: 1 },
      async () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'medium' }),
    );

    // Jev 判 max(3) → 上界 high(2)，且不能退到 medium 以下
    assert.equal(result.reasoningEffort, 'high', 'max 必须被夹取到模型支持的最高档');
    assert.ok(
      host.logs.some(([, message]) => message.includes('effort clamped')),
      '夹取必须留下日志，便于用户理解为什么档位与判定不一致',
    );
  } finally {
    fetchStub.restore();
  }
});

test('集成：模型没有推理元数据时，不去写一个会被硬拒绝的档位', async () => {
  const fetchStub = stubFetch({ jevBody: JEV_MAX });
  try {
    const { host } = await mount(
      {},
      { apiKey: API_KEY, llmRoutes: { 'deepseek-official::plain-model': null } },
    );
    emit(host, 'agent/inbox/inserted', { agent: { id: 'cap-2' }, message: { content: '彻底重构' } });

    const result = await waterfall(
      host,
      'agent/request',
      { agent: { id: 'cap-2' }, turn: 1, step: 1 },
      async () => ({ provider: 'deepseek-official', model: 'plain-model', reasoningEffort: undefined }),
    );

    assert.equal(result.reasoningEffort, undefined, '不支持推理的模型上一个档位都不能设');
  } finally {
    fetchStub.restore();
  }
});

test('集成：llm 服务不可用时安全降级（不设档位，不崩）', async () => {
  const fetchStub = stubFetch({ jevBody: JEV_MAX });
  try {
    // llmRoutes 传了空对象 → 任何路由都解析失败
    const { host } = await mount({}, { apiKey: API_KEY, llmRoutes: {} });
    emit(host, 'agent/inbox/inserted', { agent: { id: 'cap-3' }, message: { content: '彻底重构' } });

    const result = await waterfall(
      host,
      'agent/request',
      { agent: { id: 'cap-3' }, turn: 1, step: 1 },
      async () => ({ provider: 'deepseek-official', model: 'mystery', reasoningEffort: 'high' }),
    );

    assert.equal(result.reasoningEffort, 'high', '解析不了能力时保留 harness 原值');
    assert.equal(result.model, 'mystery', '不应擅自改模型');
  } finally {
    fetchStub.restore();
  }
});

test('集成：候选模型解析不了时拒绝切换（而不是制造一个失败的请求）', async () => {
  const fetchStub = stubFetch({ jevBody: JEV_MAX });
  try {
    const { host } = await mount(
      {
        modelRouting: true,
        acknowledgeCacheRisk: true,
        modelAllowlist: ['deepseek-v4-pro'],
        stickyRounds: 1,
        switchCooldown: 0,
      },
      { apiKey: API_KEY, llmRoutes: { 'deepseek-official::deepseek-v4-flash': ['off', 'low', 'high', 'max'] } },
    );
    emit(host, 'agent/inbox/inserted', { agent: { id: 'cap-4' }, message: { content: '彻底重构' } });

    const result = await waterfall(
      host,
      'agent/request',
      { agent: { id: 'cap-4' }, turn: 1, step: 1 },
      async () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }),
    );

    assert.equal(result.model, 'deepseek-v4-flash', '候选解析失败时必须保持原模型');
    assert.ok(
      host.logs.some(([level, message]) => level === 'warn' && message.includes('无法解析')),
      '必须告警，否则用户不知道为什么路由没生效',
    );
  } finally {
    fetchStub.restore();
  }
});

test('集成：provider::model 白名单 + 自备价目 → 跨 provider 切换成立', async () => {
  const fetchStub = stubFetch({ jevBody: jevChoosing('openai-codex::gpt-5.6-luna') });
  try {
    const { host } = await mount(
      {
        modelRouting: true,
        acknowledgeCacheRisk: true,
        modelAllowlist: ['openai-codex::gpt-5.6-luna'],
        customPricing: ['openai-codex::gpt-5.6-luna=0.1,0.5,2'],
        stickyRounds: 1,
        switchCooldown: 0,
      },
      {
        apiKey: API_KEY,
        initiatorId: 'cap-5',
        llmRoutes: {
          'deepseek-official::deepseek-v4-flash': ['off', 'low', 'high', 'max'],
          'openai-codex::gpt-5.6-luna': ['minimal', 'low', 'medium', 'high'],
        },
      },
    );

    emit(host, 'agent/inbox/inserted', { agent: { id: 'cap-5' }, message: { content: '彻底重构' } });

    const stream = await waterfall(host, 'llm/stream', { model: 'deepseek-v4-flash' }, () =>
      (async function* () {
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 6000, cacheReadTokens: 0, reasoningTokens: 6000 } };
      })(),
    );
    for await (const _chunk of stream) { /* 消费掉 */ }

    const result = await waterfall(
      host,
      'agent/request',
      { agent: { id: 'cap-5' }, turn: 1, step: 1 },
      async () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }),
    );

    assert.equal(result.provider, 'openai-codex', '跨 provider 路由必须同时改 provider');
    assert.equal(result.model, 'gpt-5.6-luna', 'model 必须与 provider 成对切换');
  } finally {
    fetchStub.restore();
  }
});

test('集成：没有价目的模型被成本闸拒绝（no-pricing），不猜也不放行', async () => {
  const fetchStub = stubFetch({ jevBody: jevChoosing('ollama::some-local-model') });
  try {
    const { host } = await mount(
      {
        modelRouting: true,
        acknowledgeCacheRisk: true,
        modelAllowlist: ['ollama::some-local-model'],
        stickyRounds: 1,
        switchCooldown: 0,
      },
      {
        apiKey: API_KEY,
        llmRoutes: {
          'deepseek-official::deepseek-v4-flash': ['off', 'low', 'high', 'max'],
          'ollama::some-local-model': ['low', 'high'],
        },
      },
    );
    emit(host, 'agent/inbox/inserted', { agent: { id: 'cap-6' }, message: { content: '彻底重构' } });

    const result = await waterfall(
      host,
      'agent/request',
      { agent: { id: 'cap-6' }, turn: 1, step: 1 },
      async () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }),
    );

    assert.equal(result.model, 'deepseek-v4-flash', '没有价目就无法论证收益，必须拒绝');
    assert.ok(
      host.logs.some(([, message]) => message.includes('no-pricing')),
      '拒绝原因必须是 no-pricing（而不是被白名单挡下），否则这条测试会假通过',
    );
  } finally {
    fetchStub.restore();
  }
});

// ── 计量口径 ────────────────────────────────────────────────
test('集成：标题/压缩调用不计入命中率（purpose 标记）', async () => {
  const { host } = await mount();

  const makeStream = (usage) => () =>
    (async function* () {
      yield { type: 'usage', usage };
    })();

  // 一次正常调用
  let stream = await waterfall(host, 'llm/stream', { model: 'm' }, makeStream({ inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 10, reasoningTokens: 0 }));
  for await (const _c of stream) { /* consume */ }

  // 两次辅助调用（标题、压缩）
  for (const purpose of ['session-title', 'compaction']) {
    stream = await waterfall(host, 'llm/stream', { model: 'm', purpose }, makeStream({ inputTokens: 500, cacheReadTokens: 0, outputTokens: 5, reasoningTokens: 0 }));
    for await (const _c of stream) { /* consume */ }
  }

  const route = host.registeredRoutes.get('/jev-router/status');
  const response = fakeResponse();
  await route.handler(fakeRequest({ method: 'GET' }), response);
  const body = JSON.parse(response.captured.body);

  assert.equal(body.metrics.steps, 1, '只有正常调用计入 steps');
  assert.equal(body.metrics.auxiliaryCalls, 2, '辅助调用单独计数');
  assert.equal(body.metrics.inputTokens, 1000, '辅助调用的未命中 token 不应污染命中率');
  assert.ok(body.metrics.hitRate > 0.89, `命中率应只反映正常调用，实际 ${body.metrics.hitRate}`);
});

// ── volatile 配置形态（实机启动才暴露的那一类问题） ──────────
test('回归：配置以 volatile 引用对象交付时，Tier B 的开关必须真的生效', async () => {
  const fetchStub = stubFetch({ jevBody: jevChoosing('deepseek-v4-pro') });
  try {
    const { host } = await mount(
      {
        modelRouting: true,
        acknowledgeCacheRisk: true,
        modelAllowlist: ['deepseek-v4-pro'],
        stickyRounds: 1,
        switchCooldown: 0,
        hitRateAlert: 0.9,
      },
      { apiKey: API_KEY, initiatorId: 'vol-1', volatileConfig: true },
    );

    // 状态路由必须报出裸值，而不是 `{}` 或恒 false
    const route = host.registeredRoutes.get('/jev-router/status');
    const response = fakeResponse();
    await route.handler(fakeRequest({ method: 'GET' }), response);
    const body = JSON.parse(response.captured.body);

    assert.equal(body.config.modelRouting, true, 'volatile 包装没拆 → 这里会是 false，Tier B 永远打不开');
    assert.equal(body.config.acknowledgeCacheRisk, true);
    assert.equal(body.config.effort, 'auto', 'volatile 包装没拆 → effort 会序列化成 {}');
    assert.equal(body.config.hitRateAlert, 0.9);

    // 并且真的能切模型
    emit(host, 'agent/inbox/inserted', { agent: { id: 'vol-1' }, message: { content: '彻底重构' } });
    const stream = await waterfall(host, 'llm/stream', { model: 'deepseek-v4-flash' }, () =>
      (async function* () {
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 6000, cacheReadTokens: 0, reasoningTokens: 6000 } };
      })(),
    );
    for await (const _chunk of stream) { /* consume */ }

    const result = await waterfall(
      host,
      'agent/request',
      { agent: { id: 'vol-1' }, turn: 1, step: 1 },
      async () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }),
    );
    assert.equal(result.model, 'deepseek-v4-pro', 'volatile 形态下模型路由也必须工作');
    assert.equal(result.reasoningEffort, 'max');
  } finally {
    fetchStub.restore();
  }
});

test('回归：volatile 形态下 confidenceFloor 参与比较（NaN 会让门槛失效）', async () => {
  // Jev 给 0.4 置信度，阈值 0.6 —— 必须弃权。
  // 若 confidenceFloor 是引用对象，`0.4 < 引用对象` 为 false，判定的低置信度会被误当成可信。
  const lowConfidence = {
    model: 'jev-1.13.0',
    answers: {
      effort: { type: 'choice', choice: 'max', probabilities: { max: 0.4 }, confidence: 0.4 },
    },
    usage: {},
  };
  const fetchStub = stubFetch({ jevBody: lowConfidence });
  try {
    const { host } = await mount(
      { confidenceFloor: 0.6 },
      { apiKey: API_KEY, volatileConfig: true },
    );
    emit(host, 'agent/inbox/inserted', { agent: { id: 'vol-2' }, message: { content: '彻底重构' } });

    const result = await waterfall(
      host,
      'agent/request',
      { agent: { id: 'vol-2' }, turn: 1, step: 1 },
      async () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }),
    );

    assert.equal(result.reasoningEffort, 'low', '低于阈值的判定必须弃权，保留 harness 原值');
  } finally {
    fetchStub.restore();
  }
});

// ── 会话状态必须跨轮存活（本 bug 的核心回归） ────────────────
test('回归：agent 每轮结束被注销后，策略状态必须跨轮保留（否则降档永不生效）', async () => {
  // DSH 在一轮驱动空闲后会注销 agent 并派发 agent/disposed
  // （源码注释：*after driver quiescence*）。若在那个事件上删状态，
  // lowStreak 永远累不到 downgradeStreak —— 降档就是死代码。
  const fetchStub = stubFetch({ jevBody: jevWithEffort('low') });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });
    const produce = async () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' });

    // ── 第 1 轮：判 low，但降档需要连续确认 → 挂起 ──
    emit(host, 'agent/inbox/inserted', { agent: { id: 'keep-1' }, message: { content: '今天几号' } });
    const first = await waterfall(host, 'agent/request', { agent: { id: 'keep-1' }, turn: 1, step: 1 }, produce);
    assert.equal(first.reasoningEffort, 'high', '第一轮判低只记账，不应立刻降档');

    let status = JSON.parse(
      (await (async () => {
        const res = fakeResponse();
        await host.registeredRoutes.get('/jev-router/status').handler(fakeRequest({ method: 'GET' }), res);
        return res.captured.body;
      })()),
    );
    assert.equal(status.session.lastEffortVerdict.reason, 'downgrade-pending');
    assert.equal(status.diagnostics.state.lowStreak, 1);
    assert.equal(status.diagnostics.sessionsCreated, 1);

    // ── 模拟 DSH 在一轮结束时注销 agent ──
    emit(host, 'agent/disposed', { agent: { id: 'keep-1' } });

    // ── 第 2 轮：再判 low → 连续确认满足，必须真的降档 ──
    emit(host, 'agent/inbox/inserted', { agent: { id: 'keep-1' }, message: { content: '今天几号' } });
    const second = await waterfall(host, 'agent/request', { agent: { id: 'keep-1' }, turn: 2, step: 1 }, produce);

    assert.equal(second.reasoningEffort, 'low', '第二轮判低必须真的降档');

    status = JSON.parse(
      (await (async () => {
        const res = fakeResponse();
        await host.registeredRoutes.get('/jev-router/status').handler(fakeRequest({ method: 'GET' }), res);
        return res.captured.body;
      })()),
    );
    assert.equal(status.session.lastEffortVerdict.reason, 'downgrade');
    assert.equal(status.session.lastEffortVerdict.changed, true);
    assert.equal(status.session.effort, 'low');

    // 诊断数字：disposal 只计数，绝不淘汰状态
    assert.equal(status.diagnostics.disposedSignals, 1, 'disposal 信号被计数');
    assert.equal(status.diagnostics.sessionsCreated, 1, '不得因为 disposal 而重建会话状态');
    assert.equal(status.diagnostics.sessionsEvicted, 0, 'disposal 不得淘汰状态');
    assert.equal(status.diagnostics.state.lowStreak, 0, '降档后计数归零');
  } finally {
    fetchStub.restore();
  }
});

test('回归：agent/disposed 不得清空会话状态（同一 agent id 复用）', () => {
  // 这条更直接：只发 disposal，然后确认状态还在。
  return (async () => {
    const { host } = await mount({}, { apiKey: API_KEY });
    emit(host, 'agent/inbox/inserted', { agent: { id: 'keep-2' }, message: { content: '随便问一句' } });
    await waterfall(host, 'agent/request', { agent: { id: 'keep-2' }, turn: 1, step: 1 }, async () => ({
      provider: 'p',
      model: 'm',
      reasoningEffort: 'high',
    }));

    for (let i = 0; i < 3; i += 1) emit(host, 'agent/disposed', { agent: { id: 'keep-2' } });

    const res = fakeResponse();
    await host.registeredRoutes.get('/jev-router/status').handler(fakeRequest({ method: 'GET' }), res);
    const body = JSON.parse(res.captured.body);

    assert.ok(body.diagnostics.state, '状态必须还在');
    assert.equal(body.diagnostics.disposedSignals, 3);
    assert.equal(body.diagnostics.sessionsCreated, 1);
    assert.equal(body.diagnostics.sessionsEvicted, 0);
  })();
});

// ── 连通测试路由 ────────────────────────────────────────────
test('连通测试：Key 可用时返回接通信息', async () => {
  const fetchStub = stubFetch({ jevBody: jevWithEffort('low', 0.9) });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });
    const route = host.registeredRoutes.get('/jev-router/test');
    const response = fakeResponse();

    await route.handler(fakeRequest({ method: 'POST', headers: {} }), response);

    assert.equal(response.captured.status, 200);
    const body = JSON.parse(response.captured.body);
    assert.equal(body.ok, true);
    assert.equal(body.effort, 'low');
    assert.equal(body.jevModel, 'jev-1.13.0');
    assert.ok(typeof body.elapsedMs === 'number');
  } finally {
    fetchStub.restore();
  }
});

test('连通测试：没有 Key 时明确报未配置，且不发网络请求', async () => {
  const fetchStub = stubFetch({ jevBody: jevWithEffort('low') });
  try {
    const { host } = await mount({}, { apiKey: null });
    const route = host.registeredRoutes.get('/jev-router/test');
    const response = fakeResponse();

    await route.handler(fakeRequest({ method: 'POST', headers: {} }), response);

    assert.equal(response.captured.status, 502);
    const body = JSON.parse(response.captured.body);
    assert.equal(body.ok, false);
    assert.match(body.reason, /未配置/);
    assert.equal(fetchStub.calls.length, 0, '未配置时不得发请求');
  } finally {
    fetchStub.restore();
  }
});

test('连通测试：请求失败时报「未接通」而不是假装成功', async () => {
  const fetchStub = stubFetch({ jevOk: false });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });
    const route = host.registeredRoutes.get('/jev-router/test');
    const response = fakeResponse();

    await route.handler(fakeRequest({ method: 'POST', headers: {} }), response);

    assert.equal(response.captured.status, 502);
    assert.equal(JSON.parse(response.captured.body).ok, false);
  } finally {
    fetchStub.restore();
  }
});

test('连通测试：拒绝跨站来源', async () => {
  const { host } = await mount({}, { apiKey: API_KEY });
  const route = host.registeredRoutes.get('/jev-router/test');
  const response = fakeResponse();

  await route.handler(
    fakeRequest({ method: 'POST', headers: { origin: 'https://evil.example', host: '127.0.0.1:19387' } }),
    response,
  );

  assert.equal(response.captured.status, 403);
});

test('状态快照必须公开全部可调字段（否则设置页没有可调项）', async () => {
  const { host } = await mount();
  const route = host.registeredRoutes.get('/jev-router/status');
  const response = fakeResponse();
  await route.handler(fakeRequest({ method: 'GET' }), response);

  const cfg = JSON.parse(response.captured.body).config;
  for (const key of ['riskCeiling', 'confidenceFloor', 'hysteresisRounds', 'downgradeStreak', 'timeoutMs', 'fallbackEffort']) {
    assert.ok(key in cfg, `status.config 缺少可调字段：${key}`);
  }
  assert.equal(typeof cfg.riskCeiling, 'number', 'volatile 字段必须已拆包为裸值');
  assert.equal(typeof cfg.confidenceFloor, 'number');
  assert.equal(cfg.riskCeiling, 0.6);
});

// ── Jev 失败必须可观测（用户实际遇到「你好」走 heuristic）────────
test('回归：Jev 超时降级为关键词表时，必须留下失败原因', async () => {
  // 实测：冷启动 1367ms、热调用 358ms，而早先 timeoutMs 默认 1500ms ——
  // 重启后第一次判定几乎必然超时，且**静默**降级，用户看到的是
  // 「这个能力没生效」。所以失败原因必须被记录并可查询。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';
    throw error;
  };
  try {
    const { host } = await mount({ timeoutMs: 50 }, { apiKey: API_KEY });
    emit(host, 'agent/inbox/inserted', { agent: { id: 'fail-1' }, message: { content: '你好' } });
    await waterfall(host, 'agent/request', { agent: { id: 'fail-1' }, turn: 1, step: 1 }, async () => ({
      provider: 'p', model: 'm', reasoningEffort: 'high',
    }));

    const res = fakeResponse();
    await host.registeredRoutes.get('/jev-router/status').handler(fakeRequest({ method: 'GET' }), res);
    const body = JSON.parse(res.captured.body);

    assert.equal(body.session.source, 'heuristic', '失败后应当回退关键词表');
    assert.ok(body.diagnostics.jevFailure, '必须记录失败原因，不能静默');
    assert.equal(body.diagnostics.jevFailure.kind, 'timeout', '应识别为超时');
    assert.equal(body.diagnostics.jevFailure.timeoutMs, 50);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('回归：Jev 成功时清空上一次的失败记录', async () => {
  const fetchStub = stubFetch({ jevBody: jevWithEffort('high', 0.9) });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });
    emit(host, 'agent/inbox/inserted', { agent: { id: 'ok-1' }, message: { content: '你好' } });
    await waterfall(host, 'agent/request', { agent: { id: 'ok-1' }, turn: 1, step: 1 }, async () => ({
      provider: 'p', model: 'm', reasoningEffort: 'low',
    }));

    const res = fakeResponse();
    await host.registeredRoutes.get('/jev-router/status').handler(fakeRequest({ method: 'GET' }), res);
    const body = JSON.parse(res.captured.body);
    assert.equal(body.session.source.startsWith('jev('), true);
    assert.equal(body.diagnostics.jevFailure, null, '成功时不应残留失败记录');
  } finally {
    fetchStub.restore();
  }
});

test('默认 timeoutMs 必须给冷启动留余量（不能卡在热调用中位数上）', async () => {
  const { DEFAULTS } = await import('../lib/config.js');
  // 实测冷启动 1367-1463ms，热调用 358-548ms。
  assert.ok(
    DEFAULTS.timeoutMs >= 3000,
    `timeoutMs 默认值 ${DEFAULTS.timeoutMs}ms 太紧：冷启动实测可达 1463ms，会在重启后首次判定超时`,
  );
});

test('回归：未配置 Key 时也要记录可区分的原因（而不是无声无息）', async () => {
  // 「没配 Key」与「请求失败」在界面上必须能区分开，
  // 否则用户只会看到"能力没生效"，不知道该去配 Key 还是查网络。
  const { host } = await mount({}, { apiKey: null });
  emit(host, 'agent/inbox/inserted', { agent: { id: 'nokey-1' }, message: { content: '你好' } });
  await waterfall(host, 'agent/request', { agent: { id: 'nokey-1' }, turn: 1, step: 1 }, async () => ({
    provider: 'p', model: 'm', reasoningEffort: 'high',
  }));

  const res = fakeResponse();
  await host.registeredRoutes.get('/jev-router/status').handler(fakeRequest({ method: 'GET' }), res);
  const body = JSON.parse(res.captured.body);

  assert.equal(body.session.source, 'heuristic');
  assert.ok(body.diagnostics.jevFailure, '必须留下原因');
  assert.equal(body.diagnostics.jevFailure.kind, 'not-configured', '应能区分「未配置」与「请求失败」');
});

// ── 多会话下的状态定位（用户实际遇到：A 会话显示 B 会话的 off）──
test('回归：?session= 必须精确定位到该会话，不能串到别的会话', async () => {
  // 会话 A 的判定低风险（立即降档到 low），会话 B 的高风险（挂起，仍是 high）。
  // 两者档位不同，才能证明 ?session= 真的按会话取数。
  let call = 0;
  const fetchStub = stubFetch({
    jevBody: () => {
      call += 1;
      return call === 1 ? jevWithEffort('low', 0.95, 0.1) : jevWithEffort('off', 1, 2);
    },
  });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });
    const base = async () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' });

    emit(host, 'agent/inbox/inserted', { agent: { id: 'sess-A' }, message: { content: '随便问问' } });
    await waterfall(host, 'agent/request', { agent: { id: 'sess-A' }, turn: 1, step: 1 }, base);

    emit(host, 'agent/inbox/inserted', { agent: { id: 'sess-B' }, message: { content: '你好' } });
    await waterfall(host, 'agent/request', { agent: { id: 'sess-B' }, turn: 1, step: 1 }, base);

    const route = host.registeredRoutes.get('/jev-router/status');
    const read = async (url) => {
      const res = fakeResponse();
      await route.handler(fakeRequest({ method: 'GET', url }), res);
      return JSON.parse(res.captured.body);
    };

    // 不带 session → 只能兜底，但必须**标明**是兜底
    const fallback = await read('/jev-router/status');
    assert.equal(fallback.session.scope, 'most-recent', '没有 session 参数时必须标明是兜底');

    // 带 session=A → 精确返回 A（low），不能是最近活跃的 B（high）
    const a = await read('/jev-router/status?session=sess-A');
    assert.equal(a.session.scope, 'exact');
    assert.equal(a.session.sessionKey, 'sess-A');
    assert.equal(a.session.effort, 'low', 'A 会话是 low，不能被 B 覆盖');

    const b = await read('/jev-router/status?session=sess-B');
    assert.equal(b.session.scope, 'exact');
    assert.equal(b.session.sessionKey, 'sess-B');
    assert.equal(b.session.effort, 'high', 'B 会话高风险降档挂起，仍是 high');
  } finally {
    fetchStub.restore();
  }
});

test('回归：两个会话的状态必须彼此独立（各自的确认计数互不影响）', async () => {
  // 同一个判定（低档 + 高风险 → 需连续确认），A 走两轮、B 走一轮。
  // 若状态串号，B 会跟着 A 一起降档。
  const fetchStub = stubFetch({ jevBody: jevWithEffort('low', 0.95, 2) });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });
    const base = async () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' });

    for (const [id, turn] of [['A', 1], ['A', 2], ['B', 1]]) {
      emit(host, 'agent/inbox/inserted', { agent: { id: 'iso-' + id }, message: { content: '问问' } });
      await waterfall(host, 'agent/request', { agent: { id: 'iso-' + id }, turn, step: 1 }, base);
    }

    const route = host.registeredRoutes.get('/jev-router/status');
    const read = async (q) => {
      const res = fakeResponse();
      await route.handler(fakeRequest({ method: 'GET', url: '/jev-router/status' + q }), res);
      return JSON.parse(res.captured.body);
    };

    const a = await read('?session=iso-A');
    const b = await read('?session=iso-B');

    assert.equal(a.session.effort, 'low', 'A 走了两轮，应已降档');
    assert.equal(b.session.effort, 'high', 'B 只走一轮，仍在挂起确认，不能受 A 影响');
    assert.equal(b.session.lastEffortVerdict.reason, 'downgrade-pending');
  } finally {
    fetchStub.restore();
  }
});

test('诊断：status 请求的会话定位统计（用于事后确认徽章有没有带 sessionId）', async () => {
  const fetchStub = stubFetch({ jevBody: jevWithEffort('low', 0.9, 0.1) });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });
    emit(host, 'agent/inbox/inserted', { agent: { id: 'stat-1' }, message: { content: '问问' } });
    await waterfall(host, 'agent/request', { agent: { id: 'stat-1' }, turn: 1, step: 1 }, async () => ({
      provider: 'p', model: 'm', reasoningEffort: 'high',
    }));

    const route = host.registeredRoutes.get('/jev-router/status');
    const hit = async (url) => {
      const res = fakeResponse();
      await route.handler(fakeRequest({ method: 'GET', url }), res);
      return JSON.parse(res.captured.body);
    };

    await hit('/jev-router/status');                          // 无 session
    await hit('/jev-router/status?session=stat-1');            // 精确
    await hit('/jev-router/status?session=nope');              // 找不到

    const body = await hit('/jev-router/status?session=stat-1');
    const st = body.diagnostics.statusRequests;
    assert.equal(st.total, 4);
    assert.equal(st.withSession, 3, '三次带了 session 参数');
    assert.equal(st.exact, 2, '两次精确命中');
    assert.equal(st.mostRecent, 1, '只有无参数那次走兜底');
    assert.equal(st.noneScope, 1, '指定了不存在的 id → none，绝不用别的会话顶替');
  } finally {
    fetchStub.restore();
  }
});

// ── 档位同步进会话配置（让 DSH 原生指示器跟随）──────────────
test('生效档位必须同步进会话配置，否则原生「思考程度」永远不动', async () => {
  // Tier A 只改单次调用的 reasoningEffort；DSH 原生的档位显示读的是**会话配置**。
  // 不同步的话，界面永远停在会话设置上 —— 用户看不到插件在工作。
  const fetchStub = stubFetch({ jevBody: jevWithEffort('low', 0.95, 0.1) });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });
    const appended = [];
    const agent = {
      id: 'sync-1',
      session: { append: (type, data) => appended.push({ type, data }) },
    };

    emit(host, 'agent/inbox/inserted', { agent, message: { content: '把 JSON 格式化一下' } });
    await waterfall(host, 'agent/request', { agent, turn: 1, step: 1 }, async () => ({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high',
    }));

    const selection = appended.find((e) => e.type === 'model/selection');
    assert.ok(selection, '必须追加 model/selection，否则原生界面不知道档位变了');
    assert.equal(selection.data.reasoningEffort, 'low');
    assert.equal(selection.data.provider, 'deepseek-official');
    assert.equal(selection.data.model, 'deepseek-v4-flash', 'provider/model 是必填字段');
  } finally {
    fetchStub.restore();
  }
});

test('不变量：会话配置必须等于实际请求档位（首次建立基线，之后不重复写）', async () => {
  // 不变量是「会话配置 == 实际请求档位」，而不是「本轮裁决 changed」。
  // 首次请求时会话配置里还没有记录，因此**必须写一次**建立基线；
  // 之后再请求同一档位就不该重复写（避免无谓的持久事件）。
  const fetchStub = stubFetch({ jevBody: jevWithEffort('high', 0.95, 0.1) });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });
    const appended = [];
    const agent = {
      id: 'sync-2',
      session: { append: (type, data) => appended.push({ type, data }) },
    };
    const base = async () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' });

    emit(host, 'agent/inbox/inserted', { agent, message: { content: '复杂任务' } });
    await waterfall(host, 'agent/request', { agent, turn: 1, step: 1 }, base);
    assert.equal(appended.length, 1, '首次必须建立基线，否则原生指示器无从判断');

    // 第二轮同档位：已经一致，不该再写
    emit(host, 'agent/inbox/inserted', { agent, message: { content: '还是复杂任务' } });
    await waterfall(host, 'agent/request', { agent, turn: 2, step: 1 }, base);
    assert.equal(appended.length, 1, '档位未变时不得重复写');
  } finally {
    fetchStub.restore();
  }
});

test('不变量：同轮后续 step 沿用档位时，会话配置也保持一致', async () => {
  // 早先的漏洞：后续 step 走 entry.state.effort 这条路径，从不写会话配置，
  // 于是原生指示器停在旧值上、与请求档位分叉。
  const fetchStub = stubFetch({ jevBody: jevWithEffort('low', 0.95, 0.1) });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });
    const appended = [];
    const agent = {
      id: 'sync-steps',
      session: { append: (type, data) => appended.push({ type, data }) },
    };
    const base = async () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' });

    emit(host, 'agent/inbox/inserted', { agent, message: { content: '简单问题' } });
    const first = await waterfall(host, 'agent/request', { agent, turn: 1, step: 1 }, base);
    assert.equal(first.reasoningEffort, 'low');

    // 同一轮的后续 step：沿用 low
    const second = await waterfall(host, 'agent/request', { agent, turn: 1, step: 2 }, base);
    assert.equal(second.reasoningEffort, 'low', '后续 step 应沿用');

    const selections = appended.filter((e) => e.type === 'model/selection');
    assert.equal(selections.length, 1, '后续 step 与已同步值一致，不该重复写');
    assert.equal(selections[0].data.reasoningEffort, 'low', '会话配置必须等于请求档位');
  } finally {
    fetchStub.restore();
  }
});

test('syncSessionEffort=false 时完全不同步（尊重不写会话配置的偏好）', async () => {
  const fetchStub = stubFetch({ jevBody: jevWithEffort('low', 0.95, 0.1) });
  try {
    const { host } = await mount({ syncSessionEffort: false }, { apiKey: API_KEY });
    const appended = [];
    const agent = {
      id: 'sync-3',
      session: { append: (type, data) => appended.push({ type, data }) },
    };

    emit(host, 'agent/inbox/inserted', { agent, message: { content: '简单问题' } });
    const cfg = await waterfall(host, 'agent/request', { agent, turn: 1, step: 1 }, async () => ({
      provider: 'p', model: 'm', reasoningEffort: 'high',
    }));

    assert.equal(cfg.reasoningEffort, 'low', '请求本身仍然改档位');
    assert.equal(appended.length, 0, '但不得写会话配置');
  } finally {
    fetchStub.restore();
  }
});

test('同步失败必须留痕，不能静默', async () => {
  const fetchStub = stubFetch({ jevBody: jevWithEffort('low', 0.95, 0.1) });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });
    const agent = {
      id: 'sync-fail',
      session: {
        append: () => {
          throw new Error('session is detached');
        },
      },
    };

    emit(host, 'agent/inbox/inserted', { agent, message: { content: '简单问题' } });
    await waterfall(host, 'agent/request', { agent, turn: 1, step: 1 }, async () => ({
      provider: 'p', model: 'm', reasoningEffort: 'high',
    }));

    const res = fakeResponse();
    await host.registeredRoutes.get('/jev-router/status').handler(
      fakeRequest({ method: 'GET', url: '/jev-router/status?session=sync-fail' }),
      res,
    );
    const body = JSON.parse(res.captured.body);
    assert.equal(body.diagnostics.effortSyncFailure, 'session is detached');
  } finally {
    fetchStub.restore();
  }
});

// ── inbox：只分类真正的用户消息 ─────────────────────────────
test('回归：合成消息（runtime-context / 指令等）不得被分类或发给 Jev', async () => {
  const fetchStub = stubFetch({ jevBody: jevWithEffort('low', 0.9) });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });

    // 合成消息：runtime-context 快照、workspace 指令等也进 inbox
    for (const kind of ['runtime-context', 'agent-instructions', 'goal', 'tool-jobs', 'user-approval']) {
      emit(host, 'agent/inbox/inserted', {
        agent: { id: 'synth-1' },
        message: { content: `synthetic ${kind} …`, source: { kind } },
      });
    }
    // skip 分支是同步的，此时不该有任何 Jev 调用
    assert.equal(
      fetchStub.calls.filter((c) => c.url.includes('api.typesafe.ai')).length,
      0,
      '合成消息不得发给 Jev（既浪费调用又竞态覆盖决策）',
    );

    // 真正的用户消息
    emit(host, 'agent/inbox/inserted', {
      agent: { id: 'synth-1' },
      message: { content: '你好', source: { kind: 'user' } },
    });
    await waterfall(host, 'agent/request', { agent: { id: 'synth-1' }, turn: 1, step: 1 }, async () => ({
      provider: 'p', model: 'm', reasoningEffort: 'high',
    }));
    assert.equal(
      fetchStub.calls.filter((c) => c.url.includes('api.typesafe.ai')).length,
      1,
      '真正的用户消息应被分类一次',
    );

    const res = fakeResponse();
    await host.registeredRoutes.get('/jev-router/status').handler(
      fakeRequest({ method: 'GET', url: '/jev-router/status?session=synth-1' }),
      res,
    );
    const body = JSON.parse(res.captured.body);
    assert.equal(body.diagnostics.inboxStats.skippedSynthetic, 5);
    assert.equal(body.diagnostics.inboxStats.classified, 1);
  } finally {
    fetchStub.restore();
  }
});

test('防御：message.source 缺失时仍分类（老 harness 兼容）', async () => {
  const fetchStub = stubFetch({ jevBody: jevWithEffort('low', 0.9) });
  try {
    const { host } = await mount({}, { apiKey: API_KEY });
    emit(host, 'agent/inbox/inserted', {
      agent: { id: 'nosrc-1' },
      message: { content: '没有 source 字段的消息' },
    });
    await waterfall(host, 'agent/request', { agent: { id: 'nosrc-1' }, turn: 1, step: 1 }, async () => ({
      provider: 'p', model: 'm', reasoningEffort: 'high',
    }));
    assert.equal(
      fetchStub.calls.filter((c) => c.url.includes('api.typesafe.ai')).length,
      1,
      'source 缺失时不得跳过分类',
    );
  } finally {
    fetchStub.restore();
  }
});

// ── setConfig 不得切断 volatile 引用 ─────────────────────────
test('回归：setConfig 不得把 volatile 引用替换成普通值', async () => {
  // 真实事故：Object.assign(live, patch) 会把 volatile 字段的
  // Object.freeze({get,[write]}) 引用替换成普通字符串/布尔，
  // 永久切断它与 settings 系统的连接——之后用户在 DSH 通用设置页
  // 改动同一字段，插件读到的是旧值。
  const { host } = await mount({}, { apiKey: API_KEY, volatileConfig: true });

  const route = host.registeredRoutes.get('/jev-router/config');
  const res = fakeResponse();
  await route.handler(
    fakeRequest({ method: 'POST', body: JSON.stringify({ patch: { effort: 'low', riskCeiling: 0.8 } }), headers: {} }),
    res,
  );
  assert.equal(JSON.parse(res.captured.body).ok, true);

  // host.config 是交付给 apply 的对象（live）；effort 必须仍是 volatile 引用
  assert.equal(typeof host.config.effort.get, 'function', 'effort 不得被替换成普通值');
  assert.equal(typeof host.config.riskCeiling.get, 'function', 'riskCeiling 不得被替换成普通值');

  // 值也要被 settings.update 写回（模拟 DSH 通用设置页后续改动）
  const write = host.config.effort[Symbol.for('cosmokit.volatile.write')];
  assert.equal(typeof write, 'function');
  write('max');
  assert.equal(host.config.effort.get(), 'max', 'volatile 引用必须仍是活的：写回后 .get() 反映新值');
});

// ── 上下文窗口闸（端到端，由真实事故驱动）────────────────────
test('回归：装不下当前会话的候选模型必须被拒绝（556K 会话 → 272K 模型）', async () => {
  // 真实事故：本会话已累积 556K token，切到窗口 272K 的 gpt-5.6-luna，
  // pi-ai 直接拒绝：CONTEXT_WINDOW_EXCEEDED。
  const fetchStub = stubFetch({ jevBody: jevChoosing('small::gpt-5.6-luna') });
  try {
    const { host } = await mount(
      {
        modelRouting: true,
        acknowledgeCacheRisk: true,
        modelAllowlist: ['small::gpt-5.6-luna'],
        customPricing: ['small::gpt-5.6-luna=0.2,0.2,1.2'],
        stickyRounds: 1,
        switchCooldown: 0,
      },
      {
        apiKey: API_KEY,
        initiatorId: 'ctx1',
        llmRoutes: { 'small::gpt-5.6-luna': ['low', 'high'] },
        // 目标模型只有 272K 窗口
        llmContextWindows: { 'small::gpt-5.6-luna': 272000 },
      },
    );

    emit(host, 'agent/inbox/inserted', { agent: { id: 'ctx1' }, message: { content: '继续做长任务' } });

    // 记一步「上下文已经很大」的历史：556K 的 prompt
    const stream = await waterfall(host, 'llm/stream', { model: 'deepseek-v4-flash' }, () =>
      (async function* () {
        yield { type: 'usage', usage: { inputTokens: 556125, outputTokens: 500, cacheReadTokens: 0, reasoningTokens: 500 } };
      })(),
    );
    for await (const _chunk of stream) { /* 消费 */ }

    const result = await waterfall(
      host,
      'agent/request',
      { agent: { id: 'ctx1' }, turn: 1, step: 1 },
      async () => ({ provider: 'small', model: 'keep', reasoningEffort: 'high' }),
    );

    assert.notEqual(result.model, 'gpt-5.6-luna', '装不下就不能切过去（那会让请求必然失败）');

    const res = fakeResponse();
    await host.registeredRoutes.get('/jev-router/status').handler(
      fakeRequest({ method: 'GET', url: '/jev-router/status?session=ctx1' }),
      res,
    );
    const body = JSON.parse(res.captured.body);
    assert.equal(body.session.lastModelVerdict.reason, 'context-too-large');
    assert.equal(body.session.lastModelVerdict.usedTokens, 556125);
    assert.equal(body.session.lastModelVerdict.targetContextWindow, 272000);
  } finally {
    fetchStub.restore();
  }
});

test('同一个大会话切到 1.05M 窗口的模型则允许（窗口差异决定成败）', async () => {
  const fetchStub = stubFetch({ jevBody: jevChoosing('big::gpt-5.6-luna') });
  try {
    const { host } = await mount(
      {
        modelRouting: true,
        acknowledgeCacheRisk: true,
        modelAllowlist: ['big::gpt-5.6-luna'],
        customPricing: ['big::gpt-5.6-luna=0.2,0.2,1.2'],
        stickyRounds: 1,
        switchCooldown: 0,
      },
      {
        apiKey: API_KEY,
        initiatorId: 'ctx2',
        llmRoutes: { 'big::gpt-5.6-luna': ['low', 'high'] },
        llmContextWindows: { 'big::gpt-5.6-luna': 1050000 },
      },
    );

    emit(host, 'agent/inbox/inserted', { agent: { id: 'ctx2' }, message: { content: '继续做长任务' } });

    const stream = await waterfall(host, 'llm/stream', { model: 'deepseek-v4-flash' }, () =>
      (async function* () {
        yield { type: 'usage', usage: { inputTokens: 556125, outputTokens: 6000, cacheReadTokens: 0, reasoningTokens: 6000 } };
      })(),
    );
    for await (const _chunk of stream) { /* 消费 */ }

    const result = await waterfall(
      host,
      'agent/request',
      { agent: { id: 'ctx2' }, turn: 1, step: 1 },
      async () => ({ provider: 'big', model: 'keep', reasoningEffort: 'high' }),
    );

    assert.equal(result.model, 'gpt-5.6-luna', '1.05M 窗口装得下 556K，应当切换');
  } finally {
    fetchStub.restore();
  }
});

test('回归：上下文闸必须用 input + cacheRead（对齐 pi-ai 的溢出判定）', async () => {
  // 依据（逐字核对过 @earendil-works/pi-ai/dist/utils/overflow.js 的 Case 2）：
  //   if (contextWindow && message.stopReason === "stop") {
  //     const inputTokens = message.usage.input + message.usage.cacheRead;
  //     if (inputTokens > contextWindow) return true;
  //   }
  // 即使服务端没报错，只要「输入总量 > 窗口」就判溢出。
  //
  // 曾经的错误修正：看到 in=57K + cache=552K 的一次请求"成功"，就改成只看 input。
  // 那段"成功"实际是 DSH 的 compaction 在反复压缩重试（日志里 7 次
  // compaction/start→end），最终仍以 CONTEXT_WINDOW_EXCEEDED 失败。
  const mod = await import('../lib/index.js');
  const { estimatePrefixTokens } = mod.__test__;
  const metrics = { lastStep: { inputTokens: 57682, cacheReadTokens: 552448 } };
  assert.equal(
    estimatePrefixTokens(metrics),
    610130,
    '必须是 input + cacheRead：热缓存的长上下文同样会超过窗口',
  );
  assert.ok(estimatePrefixTokens(metrics) > 272000, '该样本必须被判为超过 272K 窗口');
  assert.equal(mod.__test__.estimateUncachedTokens, undefined, '不得再保留"只看未命中 input"的实现');
});
