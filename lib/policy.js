/**
 * 缓存安全策略层（纯函数，便于单测）。
 *
 * 本文件是插件存在的理由。三条红线在这里被强制执行：
 *   1. 思考强度可以逐轮变——它不进 prompt 前缀，不破坏前缀缓存。
 *   2. 模型默认整段会话锁死——跨模型没有缓存复用，前缀全冷。
 *   3. 换档有迟滞——避免在档位间高频横跳，那会让每次都像首次请求。
 *
 * 盈亏平衡推导（见 docs/CACHE_SAFETY.md）：
 *   破缓存代价 = N × (P_miss − P_hit)
 *   降档收益   = Δ_out × P_out
 *   代入 P_out = 3·P_miss、P_hit = P_miss/30，得 Δ_out > 0.32·N
 *   即：破一次缓存需要省下「前缀长度 1/3」的输出 token 才回本。
 */

import { EFFORTS } from './classify.js';

/** 默认档位（与 DSH 适配器一致：thinking 开启时的默认强度）。 */
export const DEFAULT_EFFORT = 'high';

/**
 * 破缓存的盈亏平衡输出 token 数。
 *
 * @param {object} input
 * @param {number} input.prefixTokens 当前会话前缀长度
 * @param {number} input.hit 命中输入单价（$/M）
 * @param {number} input.miss 未命中输入单价（$/M）
 * @param {number} input.out 输出单价（$/M）
 * @returns {number} 需要省下的输出 token 数；价格为 0 时返回 Infinity
 */
export function breakevenOutputTokens({ prefixTokens, hit, miss, out }) {
  if (!Number.isFinite(out) || out <= 0) return Number.POSITIVE_INFINITY;
  const delta = Math.max(0, miss - hit);
  return (Math.max(0, prefixTokens) * delta) / out;
}

/**
 * 一次模型切换的额外输入成本（缓存从全命中掉到全冷）。
 *
 * @returns {number} 美元
 */
export function estimateSwitchCost({ prefixTokens, hit, miss }) {
  return (Math.max(0, prefixTokens) * Math.max(0, miss - hit)) / 1e6;
}

/** 单次会话保留的切换历史上限。 */
export const HISTORY_LIMIT = 50;

/** 历史只用于诊断与回滚，长会话里必须有界。 */
function trimHistory(state) {
  if (state.history.length > HISTORY_LIMIT) {
    state.history.splice(0, state.history.length - HISTORY_LIMIT);
  }
}

/** 新建一个会话级路由状态。 */
export function createSessionState() {
  return {
    /** 当前生效档位（null = 交给 harness 默认） */
    effort: null,
    /** 上一轮判定（用于降档的连续确认） */
    lastDecided: null,
    /** 距离上次换档经过的轮数 */
    roundsSinceEffortChange: Number.POSITIVE_INFINITY,
    /** 连续同向判定计数 */
    streak: 0,
    /** 连续判定为低档的次数（降档需要连续确认） */
    lowStreak: 0,
    /** 模型路由：当前模型与候选 */
    model: null,
    pendingModel: null,
    pendingModelStreak: 0,
    switches: 0,
    roundsSinceModelSwitch: Number.POSITIVE_INFINITY,
    /** 淘汰记录，供 /jev why 与回滚使用 */
    history: [],
  };
}

/**
 * 决定本轮的思考强度（迟滞 + 置信度门 + 降档确认）。
 *
 * 关于**降档确认**的两条豁免（都是为了让"每条消息立即生效"成立，
 * 同时不放弃"防一次误判砍掉推理强度"这个保护）：
 *
 * 1. **用户的字面指令**（关键词回退）：用户自己写下「快速回答」/「ultrathink」，
 *    再要求连续确认会削掉整个回退路径的价值。
 * 2. **低错误代价**：如果 Jev 同时判定"答错了也不要紧"（risk 低），那么
 *    这次降档的最坏后果本来就不严重，没有理由再要连续确认。
 *
 * @param {object} input
 * @param {object} input.state 会话状态（createSessionState 的产物，会被就地更新）
 * @param {object} input.config 插件配置
 * @param {string|null} input.decided Jev 判定出的档位
 * @param {number} input.confidence Jev 给出的置信度
 * @param {string} input.currentHarnessEffort harness 原本要用的档位
 * @param {boolean} [input.trusted] 判定是否来自「用户的字面指令」（关键词回退）
 * @param {number|null} [input.risk] Jev 给出的「出错代价」（0-3）
 * @returns {{effort: string|null, changed: boolean, reason: string}}
 */
export function decideEffort({
  state,
  config,
  decided,
  confidence,
  currentHarnessEffort,
  trusted = false,
  risk = null,
}) {
  const base = state.effort ?? currentHarnessEffort ?? DEFAULT_EFFORT;

  // 手动钉死的档位永远优先。
  if (config.effort && config.effort !== 'auto') {
    return finalizeEffort(state, config.effort, base, 'manual-override');
  }

  if (decided == null || !EFFORTS.includes(decided)) {
    // 本轮没有判定（Jev 没配 Key / 超时 / 解析失败）。
    // 若上一轮有过判定，就沿用它的意图——判定失败不该让档位原地不动，
    // 那会让「按消息难度自动调节」退化成「只在成功的那些轮生效」。
    const carried = state.lastDecided;
    if (carried && EFFORTS.includes(carried) && carried !== base) {
      const isDown = EFFORTS.indexOf(carried) < EFFORTS.indexOf(base);
      if (state.roundsSinceEffortChange >= config.hysteresisRounds) {
        return finalizeEffort(state, carried, base, isDown ? 'carry-downgrade' : 'carry-upgrade');
      }
      return { effort: base, changed: false, reason: 'hysteresis' };
    }
    return { effort: base, changed: false, reason: 'no-decision' };
  }
  if (!Number.isFinite(confidence) || confidence < config.confidenceFloor) {
    return { effort: base, changed: false, reason: 'low-confidence' };
  }

  if (decided === base) {
    state.streak = (state.lastDecided === decided ? state.streak : 0) + 1;
    state.lowStreak = decided === 'low' || decided === 'off' ? state.lowStreak + 1 : 0;
    state.lastDecided = decided;
    return { effort: base, changed: false, reason: 'already-there' };
  }

  // 降档需要连续确认，防止**一次误判**把强度砍掉。
  //
  // 但这道保护在下面两种情况下是多余的，跳过它可以做到"每条消息立即生效"，
  // 而这正是用户能直观感受到功能存在的前提——一个要等两轮才起作用的机制，
  // 在用户眼里就是"失效"：
  //
  //   · trusted：判定来自用户自己写下的字面指令，再确认不符合直觉；
  //   · 低错误代价：Jev 同时判定"答错了也不要紧"，那么降档的最坏后果
  //     本来就不严重，没有理由再等一轮。
  //
  // 反过来说，**错误代价高且非用户明说**的降档仍然要求确认——那才是
  // 一次误判真正会造成损失的场景。
  const isDowngrade = EFFORTS.indexOf(decided) < EFFORTS.indexOf(base);
  const lowRisk = typeof risk === 'number' && Number.isFinite(risk) && risk <= config.riskCeiling;
  const needsConfirmation = isDowngrade && !trusted && !lowRisk;
  if (needsConfirmation) {
    state.lowStreak += 1;
    if (state.lowStreak < config.downgradeStreak) {
      state.lastDecided = decided;
      return { effort: base, changed: false, reason: 'downgrade-pending' };
    }
  } else {
    state.lowStreak = 0;
  }

  // 迟滞窗口：距离上次换档太近就不动。
  if (state.roundsSinceEffortChange < config.hysteresisRounds) {
    state.lastDecided = decided;
    return { effort: base, changed: false, reason: 'hysteresis' };
  }

  return finalizeEffort(state, decided, base, isDowngrade ? 'downgrade' : 'upgrade');
}

function finalizeEffort(state, next, base, reason) {
  const changed = next !== base;
  if (changed) {
    state.effort = next;
    state.roundsSinceEffortChange = 0;
    state.streak = 0;
    state.lowStreak = 0;
    state.history.push({ kind: 'effort', from: base, to: next, reason, at: Date.now() });
    trimHistory(state);
  }
  state.lastDecided = next;
  return { effort: next, changed, reason };
}

/** 每轮结束时推进轮数计数。 */
export function tickRound(state) {
  state.roundsSinceEffortChange += 1;
  state.roundsSinceModelSwitch += 1;
}

/**
 * 是否允许自动切换模型——五道闸，按下列顺序求值（先可行性，后平滑）：
 *
 *   闸 0：用户确认过缓存风险（硬门禁，不靠文档提醒）
 *   闸 1：只允许在任务边界（turn 起点）
 *   闸 2：成本比较——预测节省必须超过破缓存代价（硬可行性过滤）
 *   闸 3：粘滞——候选模型连续 stickyRounds 轮胜出
 *   闸 4：冷却——本会话切换次数与间隔
 *
 * 成本闸刻意排在粘滞之前：不可行的切换不应累积粘滞计数，
 * 否则「候选一直赢」的语义会失真。
 *
 * @returns {{allow: boolean, reason: string, cost?: number, breakeven?: number}}
 */
export function shouldSwitchModel({
  state,
  config,
  candidate,
  candidateKey,
  candidateConfidence,
  atTurnStart,
  prefixTokens,
  pricing,
  predictedOutputSavingTokens,
}) {
  if (!config.modelRouting) return { allow: false, reason: 'tier-b-disabled' };
  if (!config.acknowledgeCacheRisk) return { allow: false, reason: 'cache-risk-not-acknowledged' };
  if (!candidate || candidate === state.model) {
    state.pendingModel = null;
    state.pendingModelStreak = 0;
    return { allow: false, reason: 'no-candidate' };
  }
  if (!Number.isFinite(candidateConfidence) || candidateConfidence < config.confidenceFloor) {
    return { allow: false, reason: 'low-confidence' };
  }
  // 白名单按**原始条目**比对：条目可能是 `provider::model`，
  // 而 candidate 已经被拆成 model，直接用 model 比对会永远匹配不上。
  const allowKey = candidateKey ?? candidate;
  if (
    Array.isArray(config.modelAllowlist) &&
    config.modelAllowlist.length > 0 &&
    !config.modelAllowlist.includes(allowKey)
  ) {
    return { allow: false, reason: 'not-allowlisted' };
  }
  if (config.modelSwitchMode !== 'turn-boundary' || !atTurnStart) {
    return { allow: false, reason: 'not-turn-boundary' };
  }
  if (state.switches >= config.maxSwitchesPerSession) {
    return { allow: false, reason: 'switch-budget-exhausted' };
  }
  if (state.roundsSinceModelSwitch < config.switchCooldown) {
    return { allow: false, reason: 'cooldown' };
  }

  // 闸 3：成本比较。放在粘滞之前——成本是硬可行性过滤，
  // 不可行的切换不该累积粘滞计数（那会让「候选一直赢」的语义失真）。
  const price = pricing ?? null;
  if (!price) return { allow: false, reason: 'no-pricing' };
  const breakeven = breakevenOutputTokens({
    prefixTokens,
    hit: price.hit,
    miss: price.miss,
    out: price.out,
  });
  const saving = Math.max(0, predictedOutputSavingTokens ?? 0);
  if (saving <= breakeven) {
    return {
      allow: false,
      reason: 'not-worth-it',
      cost: estimateSwitchCost({ prefixTokens, hit: price.hit, miss: price.miss }),
      breakeven,
    };
  }

  // 闸 2：粘滞计数
  if (state.pendingModel === candidate) {
    state.pendingModelStreak += 1;
  } else {
    state.pendingModel = candidate;
    state.pendingModelStreak = 1;
  }
  if (state.pendingModelStreak < config.stickyRounds) {
    return { allow: false, reason: `sticky-pending(${state.pendingModelStreak}/${config.stickyRounds})` };
  }

  state.model = candidate;
  state.pendingModel = null;
  state.pendingModelStreak = 0;
  state.switches += 1;
  state.roundsSinceModelSwitch = 0;
  state.history.push({ kind: 'model', to: candidate, reason: 'auto', at: Date.now() });
  trimHistory(state);
  return {
    allow: true,
    reason: 'ok',
    cost: estimateSwitchCost({ prefixTokens, hit: price.hit, miss: price.miss }),
    breakeven,
  };
}

/**
 * 预测「降档一轮能省下多少输出 token」。
 *
 * 保守估计：用本会话观察到的 reasoning token 均值当作 Δ_out 的上界。
 * 这是可解释的估计，而不是拍脑袋的常数。
 */
export function predictOutputSaving(averageReasoningTokens) {
  return Number.isFinite(averageReasoningTokens) && averageReasoningTokens > 0 ? averageReasoningTokens : 0;
}
