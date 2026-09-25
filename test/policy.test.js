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
  offFloorChars: 280,
  contextSafetyMargin: 0.05,
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

// ── 判定缺失：与 low-confidence 一致，只撤销未被支撑的降档 ──
test('回归：判定缺失绝不能沿用上一轮降档（那会绕过连续确认）', () => {
  // 早先的 carry-downgrade：上一轮判 low（高代价→挂起确认），
  // 本轮 Jev 失败 → 直接降档，绕过了 downgradeStreak 的连续确认。
  // 判定缺失比 low-confidence 更不确定，却更激进，逻辑矛盾。
  const state = createSessionState();
  state.effort = 'high';
  state.roundsSinceEffortChange = Number.POSITIVE_INFINITY;

  const verdict = decideEffort({
    state, config: CONFIG, decided: null, confidence: 0,
    currentHarnessEffort: 'high',
  });
  assert.equal(verdict.effort, 'high', '不得据此降档');
  assert.equal(verdict.reason, 'no-decision');
  assert.equal(verdict.changed, false);
});

test('回归：判定缺失时，若当前档位低于默认 → 撤销降档（回退）', () => {
  const state = createSessionState();
  state.effort = 'off';          // 之前降下来的
  state.roundsSinceEffortChange = 0;  // 迟滞窗口内也不该挡住安全回退

  const verdict = decideEffort({
    state, config: CONFIG, decided: null, confidence: 0,
    currentHarnessEffort: 'high',
  });
  assert.equal(verdict.effort, 'high');
  assert.equal(verdict.reason, 'abstain-restore');
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

// ── 弃权不得保留上一次的降档（真实质量事故的回归）────────────
test('回归：弃权时必须撤销上一次的降档，不能留在低档跑真实任务', () => {
  // 事故：先「你好」→ 立即降到 off；再来一条几百字的批改任务，
  // Jev 判 low 但置信度 0.45 < 门槛 → 弃权 → **档位留在 off**，
  // 真实任务在 thinking:disabled 下运行。
  const state = createSessionState();
  state.effort = 'off';          // 上一条"你好"降下来的
  state.roundsSinceEffortChange = 0;  // 而且迟滞窗口还没过

  const verdict = decideEffort({
    state,
    config: CONFIG,
    decided: 'low',
    confidence: 0.45,            // 低于门槛 → 弃权
    currentHarnessEffort: 'high',
  });

  assert.equal(verdict.effort, 'high', '弃权必须回退到 harness 默认，不能留在 off');
  assert.equal(verdict.reason, 'abstain-restore');
  assert.equal(verdict.changed, true);
  assert.equal(state.effort, 'high');
});

test('弃权回退绕过迟滞窗口（安全方向的修正不该被防抖挡住）', () => {
  const state = createSessionState();
  state.effort = 'off';
  state.roundsSinceEffortChange = 0;   // 迟滞本来会拦住一切变化
  const verdict = decideEffort({
    state, config: CONFIG, decided: null, confidence: 0,
    currentHarnessEffort: 'high',
  });
  assert.equal(verdict.effort, 'high', '迟滞不得挡住安全回退');
  assert.equal(verdict.reason, 'abstain-restore');
});

test('弃权但当前档位不低于默认时，保持不动（不做无意义的变化）', () => {
  const state = createSessionState();
  state.effort = 'high';
  state.roundsSinceEffortChange = Number.POSITIVE_INFINITY;
  const verdict = decideEffort({
    state, config: CONFIG, decided: 'low', confidence: 0.2,
    currentHarnessEffort: 'high',
  });
  assert.equal(verdict.effort, 'high');
  assert.equal(verdict.reason, 'low-confidence', '本就在默认档位，无需回退');
  assert.equal(verdict.changed, false);
});

test('弃权时若当前档位高于默认，不回退（只撤销降档，不撤销升档）', () => {
  const state = createSessionState();
  state.effort = 'max';
  state.roundsSinceEffortChange = Number.POSITIVE_INFINITY;
  const verdict = decideEffort({
    state, config: CONFIG, decided: 'low', confidence: 0.2,
    currentHarnessEffort: 'high',
  });
  assert.equal(verdict.effort, 'max', '升档不需要被弃权撤销');
  assert.equal(verdict.changed, false);
});

// ── off 地板：长消息不得判为「琐碎」──────────────────────────
test('回归：长消息即使被判 off 也要抬到 low（防 Jev 的 CJK 弱项）', () => {
  // off 的语义是"琐碎到不需要思考"，需要"短消息"这个正面证据。
  // Jev 对中文准确率官方说明较低，长中文请求被判 off 是高风险组合。
  const state = createSessionState();
  state.effort = 'high';
  state.roundsSinceEffortChange = Number.POSITIVE_INFINITY;

  const verdict = decideEffort({
    state, config: CONFIG, decided: 'off', confidence: 0.95,
    currentHarnessEffort: 'high', messageChars: 400, risk: 0.1,
  });
  assert.equal(verdict.effort, 'low', '长消息不得降到 off');
  assert.match(verdict.reason, /off-floor/);
});

test('短消息仍可降到 off（地板不误伤真正的琐碎请求）', () => {
  const state = createSessionState();
  state.effort = 'high';
  state.roundsSinceEffortChange = Number.POSITIVE_INFINITY;
  const verdict = decideEffort({
    state, config: CONFIG, decided: 'off', confidence: 1,
    currentHarnessEffort: 'high', messageChars: 2, risk: 0.1,
  });
  assert.equal(verdict.effort, 'off');
});

test('offFloorChars=0 关闭地板', () => {
  const state = createSessionState();
  state.effort = 'high';
  state.roundsSinceEffortChange = Number.POSITIVE_INFINITY;
  const verdict = decideEffort({
    state, config: { ...CONFIG, offFloorChars: 0 }, decided: 'off', confidence: 1,
    currentHarnessEffort: 'high', messageChars: 5000, risk: 0.1,
  });
  assert.equal(verdict.effort, 'off', '关闭后应尊重 Jev 判定');
});

test('地板只抬 off，不影响 low/high/max', () => {
  for (const d of ['low', 'high']) {
    const state = createSessionState();
    state.effort = d === 'low' ? 'high' : 'low';
    state.roundsSinceEffortChange = Number.POSITIVE_INFINITY;
    const verdict = decideEffort({
      state, config: CONFIG, decided: d, confidence: 0.9,
      currentHarnessEffort: state.effort, messageChars: 5000, risk: 0.1,
    });
    assert.equal(verdict.effort, d, `${d} 不应被地板改变`);
  }
});

// ── 上下文窗口闸（由真实事故驱动）────────────────────────────
// 事故：已累积 556K token 的会话切到窗口 272K 的模型
//       → pi-ai 直接拒绝：CONTEXT_WINDOW_EXCEEDED
const SWITCH_BASE = {
  candidateConfidence: 0.9,
  atTurnStart: true,
  prefixTokens: 1000,
  pricing: { hit: 0.003, miss: 0.15, out: 0.6, period: 'offpeak' },
  predictedOutputSavingTokens: 100000, // 让成本闸放行，隔离出窗口闸
};

function switchState() {
  const st = createSessionState();
  st.roundsSinceModelSwitch = Number.POSITIVE_INFINITY;
  return st;
}

test('回归：装不下当前会话的模型必须被拒绝（真实 556K vs 272K 事故）', () => {
  const verdict = shouldSwitchModel({
    ...SWITCH_BASE,
    state: switchState(),
    config: CONFIG,
    candidate: 'gpt-5.6-luna',
    usedTokens: 556125,        // 实测值
    targetContextWindow: 272000, // gpt-5.6-luna 经 openai-codex 的窗口
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'context-too-large');
  assert.equal(verdict.usedTokens, 556125);
  assert.equal(verdict.targetContextWindow, 272000);
  assert.ok(verdict.usableTokens < 272000, '应报告扣掉余量后的可用额度');
});

test('同一会话切到 1.05M 窗口的模型则放行（窗口差异是关键）', () => {
  // 同一个 556K 会话：1.05M 窗口装得下，272K 装不下。
  const state = switchState();
  state.pendingModel = 'gpt-5.6-luna';
  state.pendingModelStreak = CONFIG.stickyRounds - 1; // 让粘滞闸直接通过
  const verdict = shouldSwitchModel({
    ...SWITCH_BASE,
    state,
    config: CONFIG,
    candidate: 'gpt-5.6-luna',
    usedTokens: 556125,
    targetContextWindow: 1050000,
  });
  assert.equal(verdict.allow, true, '1.05M 装得下，不该拦');
});

test('窗口余量生效：刚好卡在窗口边界也拒绝（留 5% 给增长）', () => {
  const verdict = shouldSwitchModel({
    ...SWITCH_BASE,
    state: switchState(),
    config: CONFIG,
    candidate: 'm',
    usedTokens: 270000,        // < 272000，但 > 272000×0.95 = 258400
    targetContextWindow: 272000,
  });
  assert.equal(verdict.reason, 'context-too-large', '应扣掉 5% 余量再比');
});

test('余量设为 0 时用满窗口', () => {
  const verdict = shouldSwitchModel({
    ...SWITCH_BASE,
    state: switchState(),
    config: { ...CONFIG, contextSafetyMargin: 0 },
    candidate: 'm',
    usedTokens: 271000,
    targetContextWindow: 272000,
  });
  assert.notEqual(verdict.reason, 'context-too-large', '余量 0 时 271000 < 272000 应放行');
});

test('窗口或用量缺失时不拦（元数据缺失不该永久禁用切换）', () => {
  for (const args of [
    { usedTokens: 556125, targetContextWindow: null },
    { usedTokens: null, targetContextWindow: 272000 },
    { usedTokens: 0, targetContextWindow: 272000 },
  ]) {
    const state = switchState();
    state.pendingModel = 'm';
    state.pendingModelStreak = CONFIG.stickyRounds - 1;
    const verdict = shouldSwitchModel({ ...SWITCH_BASE, state, config: CONFIG, candidate: 'm', ...args });
    assert.notEqual(verdict.reason, 'context-too-large', `不该因元数据缺失而拦：${JSON.stringify(args)}`);
  }
});

test('窗口闸排在粘滞之前：被窗口拒绝的切换不得累积粘滞计数', () => {
  const state = switchState();
  shouldSwitchModel({
    ...SWITCH_BASE,
    state,
    config: CONFIG,
    candidate: 'gpt-5.6-luna',
    usedTokens: 556125,
    targetContextWindow: 272000,
  });
  assert.equal(state.pendingModelStreak, 0, '不可行的切换不该攒粘滞');
  assert.equal(state.pendingModel, null);
});
