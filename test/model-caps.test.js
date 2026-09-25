import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rankOf,
  clampEffort,
  parseAllowlistEntry,
  createCapabilityCache,
  UNKNOWN_RANK,
} from '../lib/model-caps.js';

// ── 强度轴 ──────────────────────────────────────────────────
test('rankOf: 各家命名对齐到同一条强度轴', () => {
  assert.ok(rankOf('off') < rankOf('low'));
  assert.ok(rankOf('low') <= rankOf('medium'));
  assert.ok(rankOf('medium') < rankOf('high'));
  assert.ok(rankOf('high') < rankOf('xhigh'));
  assert.equal(rankOf('off'), rankOf('none'));
  assert.equal(rankOf('low'), rankOf('minimal'));
  assert.equal(rankOf('max'), rankOf('xhigh'));
  assert.equal(rankOf('MAX'), rankOf('max'), '大小写不敏感');
});

test('rankOf: 未识别的名字按中等强度处理，不当作最高档', () => {
  assert.equal(rankOf('ludicrous'), UNKNOWN_RANK);
  assert.equal(rankOf(undefined), UNKNOWN_RANK);
  assert.ok(rankOf('ludicrous') < rankOf('max'));
});

// ── 夹取 ────────────────────────────────────────────────────
test('clampEffort: 档位受支持时原样通过', () => {
  const result = clampEffort('high', ['off', 'low', 'high', 'max']);
  assert.equal(result.effort, 'high');
  assert.equal(result.clamped, false);
  assert.equal(result.reason, 'exact');
});

test('clampEffort: 模型没有推理元数据时一个档位都不设', () => {
  for (const supported of [null, undefined, []]) {
    const result = clampEffort('max', supported);
    assert.equal(result.effort, null, `supported=${JSON.stringify(supported)} 时不应设置档位`);
    assert.equal(result.reason, 'no-reasoning-support');
  }
});

test('clampEffort: OpenAI 风格 minimal|low|medium|high —— off 往上夹到 minimal', () => {
  const result = clampEffort('off', ['minimal', 'low', 'medium', 'high']);
  assert.equal(result.effort, 'minimal');
  assert.equal(result.clamped, true);
  assert.match(result.reason, /clamped\(off->minimal\)/);
});

test('clampEffort: OpenAI 风格 —— max 往下夹到 high', () => {
  assert.equal(clampEffort('max', ['minimal', 'low', 'medium', 'high']).effort, 'high');
});

test('clampEffort: Anthropic 风格 low|medium|high|xhigh|max —— off 夹到 low', () => {
  assert.equal(clampEffort('off', ['low', 'medium', 'high', 'xhigh', 'max']).effort, 'low');
});

test('clampEffort: 只支持 off|high 的模型上 low 夹到 off（更省）', () => {
  // low(1) 到 off(0) 距离 1，到 high(2) 距离 1 —— 同距离取更强的那个
  const result = clampEffort('low', ['off', 'high']);
  assert.equal(result.effort, 'high', '同距离时取更强的一侧，避免夹取过猛伤质量');
});

test('clampEffort: 同距离时取列表中靠后的（即更强）那个', () => {
  const result = clampEffort('medium', ['low', 'high']);
  assert.equal(result.effort, 'high');
});

test('clampEffort: 只有一个档位时永远夹到它', () => {
  assert.equal(clampEffort('off', ['high']).effort, 'high');
  assert.equal(clampEffort('max', ['off']).effort, 'off');
});

// ── 白名单条目解析 ──────────────────────────────────────────
test('parseAllowlistEntry: 裸模型 id 表示当前 provider', () => {
  const parsed = parseAllowlistEntry('deepseek-v4-pro');
  assert.deepEqual(parsed, { provider: undefined, model: 'deepseek-v4-pro', raw: 'deepseek-v4-pro' });
});

test('parseAllowlistEntry: provider::model 显式指定 provider', () => {
  const parsed = parseAllowlistEntry('openai-codex::gpt-5.6-luna');
  assert.equal(parsed.provider, 'openai-codex');
  assert.equal(parsed.model, 'gpt-5.6-luna');
});

test('parseAllowlistEntry: 模型 id 里的斜杠与冒号不会被误当分隔符', () => {
  // 这是真实存在的 ollama 模型 id；用 provider/model 或 provider:model 都会解析错。
  const parsed = parseAllowlistEntry('orcarouter/Qwen3.8-27B-Uncensored:q5_K_M');
  assert.equal(parsed.provider, undefined);
  assert.equal(parsed.model, 'orcarouter/Qwen3.8-27B-Uncensored:q5_K_M');

  const qualified = parseAllowlistEntry('ollama::orcarouter/Qwen3.8-27B-Uncensored:q5_K_M');
  assert.equal(qualified.provider, 'ollama');
  assert.equal(qualified.model, 'orcarouter/Qwen3.8-27B-Uncensored:q5_K_M');
});

test('parseAllowlistEntry: 空值要么拒绝要么原样保留', () => {
  assert.equal(parseAllowlistEntry(''), null);
  assert.equal(parseAllowlistEntry('   '), null);
  assert.equal(parseAllowlistEntry(undefined), null);
  assert.equal(parseAllowlistEntry('::model'), null, '缺 provider 的限定形式应被拒绝');
  assert.equal(parseAllowlistEntry('provider::'), null, '缺 model 的限定形式应被拒绝');
});

// ── 能力缓存 ────────────────────────────────────────────────
test('createCapabilityCache: 正面结果被缓存，只问一次', async () => {
  let calls = 0;
  const cache = createCapabilityCache({
    resolveModelInfo: async (provider, model) => {
      calls += 1;
      return { provider, id: model, reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } };
    },
  });

  const first = await cache.capabilities('p', 'm');
  const second = await cache.capabilities('p', 'm');

  assert.equal(calls, 1, '第二次应当命中缓存');
  assert.deepEqual(first.supported, ['low', 'high']);
  assert.equal(second.cached, true);
});

test('createCapabilityCache: 没有 reasoning 元数据时 supported 为 null', async () => {
  const cache = createCapabilityCache({
    resolveModelInfo: async (provider, model) => ({ provider, id: model }),
  });
  const result = await cache.capabilities('p', 'm');
  assert.equal(result.resolvable, true);
  assert.equal(result.supported, null);
});

test('createCapabilityCache: 解析失败标记为不可解析', async () => {
  const cache = createCapabilityCache({
    resolveModelInfo: async () => {
      throw new Error('unknown route');
    },
  });
  const result = await cache.capabilities('p', 'nope');
  assert.equal(result.resolvable, false);
  assert.equal(await cache.isResolvable('p', 'nope'), false);
});

test('createCapabilityCache: 负面结果按 TTL 过期，避免误伤刚挂上的 provider', async () => {
  let attempts = 0;
  const cache = createCapabilityCache({
    resolveModelInfo: async (provider, model) => {
      attempts += 1;
      if (attempts === 1) throw new Error('adapter not ready yet');
      return { provider, id: model, reasoning: { efforts: [{ id: 'high' }] } };
    },
    negativeTtlMs: 0, // 立刻过期
  });

  assert.equal((await cache.capabilities('p', 'm')).resolvable, false);
  const second = await cache.capabilities('p', 'm');
  assert.equal(second.resolvable, true, 'TTL 过期后应当重试而不是永久记成不可用');
  assert.equal(attempts, 2);
});

test('createCapabilityCache: 缺 llm 服务时安全降级为不可解析', async () => {
  const cache = createCapabilityCache({ resolveModelInfo: undefined });
  assert.equal((await cache.capabilities('p', 'm')).resolvable, false);
});
