import test from 'node:test';
import assert from 'node:assert/strict';

import {
  breakevenOutputTokens,
  estimateSwitchCost,
  createSessionState,
  decideEffort,
  shouldSwitchModel,
  predictOutputSaving,
} from '../lib/policy.js';

const CONFIG = {
  effort: 'auto',
  confidenceFloor: 0.5,
  hysteresisRounds: 2,
  downgradeStreak: 2,
  riskCeiling: 0.6,
  modelRouting: true,
  acknowledgeCacheRisk: true,
  modelSwitchMode: 'turn-boundary',
  modelAllowlist: [],
  stickyRounds: 3,
  switchCooldown: 2,
  maxSwitchesPerSession: 2,
};

// ── 盈亏平衡 ────────────────────────────────────────────────
test('breakeven: DeepSeek Pro 峰值价下约为前缀的 1/3', () => {
  // Pro 峰值：hit 0.044 / miss 1.32 / out 3.96
  const result = breakevenOutputTokens({ prefixTokens: 50000, hit: 0.044, miss: 1.32, out: 3.96 });
  assert.ok(result > 16000 && result < 17000, `期望 ~16.6K，实际 ${result}`);
});

test('breakeven: 价格为 0 时为 Infinity（无法计算则不冒险）', () => {
  assert.equal(breakevenOutputTokens({ prefixTokens: 1000, hit: 0, miss: 0, out: 0 }), Number.POSITIVE_INFINITY);
});

test('estimateSwitchCost: 50K 前缀在 Pro 峰值价下约 $0.064', () => {
  const cost = estimateSwitchCost({ prefixTokens: 50000, hit: 0.044, miss: 1.32 });
  assert.ok(Math.abs(cost - 0.0638) < 0.001, `实际 ${cost}`);
});

// ── 思考强度裁决 ────────────────────────────────────────────
test('decideEffort: 置信度低于阈值时弃权', () => {
  const state = createSessionState();
  const verdict = decideEffort({ state, config: CONFIG, decided: 'low', confidence: 0.3, currentHarnessEffort: 'high' });
  assert.equal(verdict.effort, 'high');
  assert.equal(verdict.reason, 'low-confidence');
  assert.equal(verdict.changed, false);
});

test('decideEffort: 手动钉死的档位永远优先', () => {
  const state = createSessionState();
  const verdict = decideEffort({
    state,
    config: { ...CONFIG, effort: 'max' },
    decided: 'off',
    confidence: 0.99,
    currentHarnessEffort: 'high',
  });
  assert.equal(verdict.effort, 'max');
  assert.equal(verdict.reason, 'manual-override');
});

test('decideEffort: 升档在迟滞窗口内被拒绝', () => {
  const state = createSessionState();
  state.effort = 'low';
  state.roundsSinceEffortChange = 0; // 刚换过档
  const verdict = decideEffort({ state, config: CONFIG, decided: 'max', confidence: 0.9, currentHarnessEffort: 'low' });
  assert.equal(verdict.effort, 'low');
  assert.equal(verdict.reason, 'hysteresis');
});

test('decideEffort: 降档需要连续确认', () => {
  const state = createSessionState();
  state.effort = 'high';
  state.roundsSinceEffortChange = 99;

  const first = decideEffort({ state, config: CONFIG, decided: 'low', confidence: 0.9, currentHarnessEffort: 'high' });
  assert.equal(first.effort, 'high');
  assert.equal(first.reason, 'downgrade-pending');

  const second = decideEffort({ state, config: CONFIG, decided: 'low', confidence: 0.9, currentHarnessEffort: 'high' });
  assert.equal(second.effort, 'low');
  assert.equal(second.changed, true);
});

test('decideEffort: 升档不受连续确认限制，但仍受迟滞约束', () => {
  const state = createSessionState();
  state.effort = 'low';
  state.roundsSinceEffortChange = 99;
  const verdict = decideEffort({ state, config: CONFIG, decided: 'max', confidence: 0.9, currentHarnessEffort: 'low' });
  assert.equal(verdict.effort, 'max');
  assert.equal(verdict.changed, true);
});

// ── 模型路由五道闸 ──────────────────────────────────────────
function baseArgs(overrides = {}) {
  return {
    state: createSessionState(),
    config: CONFIG,
    candidate: 'deepseek-v4-pro',
    candidateConfidence: 0.9,
    atTurnStart: true,
    prefixTokens: 50000,
    pricing: { hit: 0.044, miss: 1.32, out: 3.96 },
    predictedOutputSavingTokens: 999999, // 默认给足，单独测成本闸
    ...overrides,
  };
}

test('闸 0：未确认缓存风险时一律拒绝', () => {
  const verdict = shouldSwitchModel(baseArgs({ config: { ...CONFIG, acknowledgeCacheRisk: false } }));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'cache-risk-not-acknowledged');
});

test('闸 0：Tier B 关闭时一律拒绝（默认状态）', () => {
  const verdict = shouldSwitchModel(baseArgs({ config: { ...CONFIG, modelRouting: false } }));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'tier-b-disabled');
});

test('闸 1：非回合起点拒绝', () => {
  const verdict = shouldSwitchModel(baseArgs({ atTurnStart: false }));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'not-turn-boundary');
});

test('闸 2：粘滞轮数不足时拒绝，满足后放行', () => {
  const state = createSessionState();
  const args = { ...baseArgs({ state }), predictedOutputSavingTokens: 999999 };

  const first = shouldSwitchModel(args);
  assert.equal(first.allow, false);
  assert.match(first.reason, /^sticky-pending\(1\/3\)$/);

  assert.equal(shouldSwitchModel(args).reason, 'sticky-pending(2/3)');

  const third = shouldSwitchModel(args);
  assert.equal(third.allow, true);
  assert.equal(state.model, 'deepseek-v4-pro');
  assert.equal(state.switches, 1);
});

test('闸 3：成本不划算时拒绝——这是本插件的核心保护', () => {
  // 50K 前缀 + Pro 峰值 → 平衡点约 16.6K 输出 token
  const verdict = shouldSwitchModel(baseArgs({ predictedOutputSavingTokens: 2000 }));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'not-worth-it');
  assert.ok(verdict.breakeven > 16000);
  assert.ok(verdict.cost > 0);
});

test('闸 4：切换次数预算耗尽后拒绝', () => {
  const state = createSessionState();
  state.switches = 2; // 等于 maxSwitchesPerSession
  const verdict = shouldSwitchModel(baseArgs({ state }));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'switch-budget-exhausted');
});

test('闸 4：冷却期内拒绝', () => {
  const state = createSessionState();
  state.roundsSinceModelSwitch = 0;
  const verdict = shouldSwitchModel(baseArgs({ state }));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'cooldown');
});

test('白名单：不在名单内的模型被拒绝', () => {
  const verdict = shouldSwitchModel(baseArgs({ config: { ...CONFIG, modelAllowlist: ['deepseek-flash'] } }));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'not-allowlisted');
});

test('predictOutputSaving: 无样本时为 0（不会凭空乐观）', () => {
  assert.equal(predictOutputSaving(0), 0);
  assert.equal(predictOutputSaving(undefined), 0);
  assert.equal(predictOutputSaving(1500), 1500);
});

// ── 降档的即时生效（risk 豁免） ──────────────────────────────
// 诉求：'每条消息都立即生效'，否则用户会以为这个能力失效了。
// 但也不能放弃'防一次误判砍掉推理强度'的保护 —— 用 Jev 自己的 risk 分来区分。

test('低错误代价的降档立即生效，不再等第二轮', () => {
  // 实测"把 JSON 格式化成两空格缩进"：risk 0.30，属于"答错也不要紧"。
  const state = createSessionState();
  state.effort = 'high';
  state.roundsSinceEffortChange = Number.POSITIVE_INFINITY;

  const verdict = decideEffort({
    state,
    config: CONFIG,
    decided: 'low',
    confidence: 0.84,
    currentHarnessEffort: 'high',
    risk: 0.3,
  });

  assert.equal(verdict.effort, 'low', '低代价降档必须立即生效');
  assert.equal(verdict.reason, 'downgrade', '原因应是 downgrade，不是 downgrade-pending');
  assert.equal(verdict.changed, true);
});

test('高错误代价的降档仍然要求连续确认（保护不被削弱）', () => {
  // "线上超时定位根因"：risk 2.09 —— 答错后果严重，一次误判代价大。
  const state = createSessionState();
  state.effort = 'high';
  state.roundsSinceEffortChange = Number.POSITIVE_INFINITY;

  const first = decideEffort({
    state,
    config: CONFIG,
    decided: 'low',
    confidence: 0.99,
    currentHarnessEffort: 'high',
    risk: 2.09,
  });
  assert.equal(first.effort, 'high', '高风险降档第一轮必须挂起');
  assert.equal(first.reason, 'downgrade-pending');

  const second = decideEffort({
    state,
    config: CONFIG,
    decided: 'low',
    confidence: 0.99,
    currentHarnessEffort: 'high',
    risk: 2.09,
  });
  assert.equal(second.effort, 'low', '第二轮确认通过');
  assert.equal(second.reason, 'downgrade');
});

test('risk 边界：恰好等于 riskCeiling 时视为低代价', () => {
  const state = createSessionState();
  state.effort = 'high';
  state.roundsSinceEffortChange = Number.POSITIVE_INFINITY;
  const verdict = decideEffort({
    state, config: CONFIG, decided: 'off', confidence: 0.9,
    currentHarnessEffort: 'high', risk: CONFIG.riskCeiling,
  });
  assert.equal(verdict.reason, 'downgrade', '<= ceiling 应即时生效');
});

test('risk 缺失（Jev 未返回）时保守处理：仍需确认', () => {
  const state = createSessionState();
  state.effort = 'high';
  state.roundsSinceEffortChange = Number.POSITIVE_INFINITY;
  const verdict = decideEffort({
    state, config: CONFIG, decided: 'low', confidence: 0.9,
    currentHarnessEffort: 'high',
  });
  assert.equal(verdict.reason, 'downgrade-pending', '缺少 risk 信息时不得放宽保护');
});

test('升档不受 riskCeiling 影响（本来就不需要确认）', () => {
  const state = createSessionState();
  state.effort = 'low';
  state.roundsSinceEffortChange = Number.POSITIVE_INFINITY;
  const verdict = decideEffort({
    state, config: CONFIG, decided: 'max', confidence: 0.7,
    currentHarnessEffort: 'low', risk: 2.9,
  });
  assert.equal(verdict.effort, 'max');
  assert.equal(verdict.reason, 'upgrade');
});

// ── 判定缺失时沿用上一个判定 ────────────────────────────────
test('本轮没有判定但上一轮有 → 沿用上一轮的意图（降档）', () => {
  const state = createSessionState();
  state.effort = 'high';
  state.lastDecided = 'low';
  state.roundsSinceEffortChange = Number.POSITIVE_INFINITY;

  const verdict = decideEffort({
    state, config: CONFIG, decided: null, confidence: 0,
    currentHarnessEffort: 'high',
  });
  assert.equal(verdict.effort, 'low');
  assert.equal(verdict.reason, 'carry-downgrade');
});

test('沿用也受迟滞窗口约束', () => {
  const state = createSessionState();
  state.effort = 'high';
  state.lastDecided = 'low';
  state.roundsSinceEffortChange = 0;

  const verdict = decideEffort({
    state, config: CONFIG, decided: null, confidence: 0,
    currentHarnessEffort: 'high',
  });
  assert.equal(verdict.effort, 'high');
  assert.equal(verdict.reason, 'hysteresis');
});

test('从未有过判定且本轮也没有 → no-decision，保持不动', () => {
  const state = createSessionState();
  state.effort = 'high';
  state.roundsSinceEffortChange = Number.POSITIVE_INFINITY;
  const verdict = decideEffort({
    state, config: CONFIG, decided: null, confidence: 0,
    currentHarnessEffort: 'high',
  });
  assert.equal(verdict.effort, 'high');
  assert.equal(verdict.reason, 'no-decision');
});
