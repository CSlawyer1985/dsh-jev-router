/**
 * 度量层：从模型调用的 usage 里累计缓存命中与成本，供设置页与告警使用。
 *
 * 字段名来自 DSH 持久化的 usage 形状（已在用户真实会话日志中核对）：
 *   { inputTokens, outputTokens, cacheReadTokens, reasoningTokens }
 * 其中 inputTokens 是**未命中**部分、cacheReadTokens 是命中部分，
 * 因此命中率 = cacheRead / (cacheRead + input)。
 */

/** 新建一个度量累加器。 */
export function createMetrics({ windowSize = 50 } = {}) {
  return {
    steps: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    /** 标题 / 压缩等辅助调用次数：单独计数，不进命中率指标。 */
    auxiliaryCalls: 0,
    /** 最近若干步，用于窗口命中率（全局均值会被超长上下文主导）。 */
    window: [],
    windowSize,
    lastStep: null,
  };
}

/**
 * 记录一次模型调用的 usage。
 *
 * @param {object} metrics createMetrics 的产物（就地更新）
 * @param {object} usage {inputTokens, outputTokens, cacheReadTokens, reasoningTokens}
 * @param {object} [meta] {agentId, model, provider, effort}
 */
export function recordUsage(metrics, usage, meta = {}) {
  if (!usage || typeof usage !== 'object') return;
  const input = num(usage.inputTokens);
  const cache = num(usage.cacheReadTokens);
  const output = num(usage.outputTokens);
  const reasoning = num(usage.reasoningTokens);

  metrics.steps += 1;
  metrics.inputTokens += input;
  metrics.cacheReadTokens += cache;
  metrics.outputTokens += output;
  metrics.reasoningTokens += reasoning;

  const entry = {
    inputTokens: input,
    cacheReadTokens: cache,
    outputTokens: output,
    reasoningTokens: reasoning,
    at: Date.now(),
    ...meta,
  };
  metrics.lastStep = entry;
  metrics.window.push(entry);
  if (metrics.window.length > metrics.windowSize) metrics.window.shift();
}

function num(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 命中率。命中+未命中为 0 时返回 null（无样本，不要显示 0% 误导）。 */
export function hitRate(totals) {
  const total = totals.cacheReadTokens + totals.inputTokens;
  return total > 0 ? totals.cacheReadTokens / total : null;
}

/**
 * 汇总快照。
 *
 * @param {object} metrics
 * @param {object|null} price 当前时段单价 {hit, miss, out}
 * @returns {object}
 */
export function snapshot(metrics, price = null) {
  const overall = hitRate(metrics);

  const win = metrics.window.reduce(
    (acc, entry) => {
      acc.inputTokens += entry.inputTokens;
      acc.cacheReadTokens += entry.cacheReadTokens;
      acc.outputTokens += entry.outputTokens;
      acc.reasoningTokens += entry.reasoningTokens;
      return acc;
    },
    { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  );
  const windowHitRate = hitRate(win);

  const avgReasoningTokens =
    metrics.window.length > 0
      ? win.reasoningTokens / metrics.window.length
      : metrics.steps > 0
        ? metrics.reasoningTokens / metrics.steps
        : 0;

  const reasoningShare = metrics.outputTokens > 0 ? metrics.reasoningTokens / metrics.outputTokens : null;

  let cacheSavingUsd = null;
  if (price && Number.isFinite(price.miss) && Number.isFinite(price.hit)) {
    cacheSavingUsd = (metrics.cacheReadTokens * Math.max(0, price.miss - price.hit)) / 1e6;
  }

  return {
    steps: metrics.steps,
    auxiliaryCalls: metrics.auxiliaryCalls ?? 0,
    inputTokens: metrics.inputTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    outputTokens: metrics.outputTokens,
    reasoningTokens: metrics.reasoningTokens,
    hitRate: overall,
    windowHitRate,
    windowSteps: metrics.window.length,
    reasoningShare,
    avgReasoningTokens,
    cacheSavingUsd,
    lastStep: metrics.lastStep,
  };
}

/**
 * 命中率告警判定。
 *
 * 只有样本足够（命中+未命中 ≥ minTokens）才告警，避免会话开头的冷启动误报。
 */
export function shouldAlert({ metrics, price, threshold, minTokens = 20000 }) {
  const win = metrics.window.reduce(
    (acc, entry) => {
      acc.inputTokens += entry.inputTokens;
      acc.cacheReadTokens += entry.cacheReadTokens;
      return acc;
    },
    { inputTokens: 0, cacheReadTokens: 0 },
  );
  const total = win.cacheReadTokens + win.inputTokens;
  if (total < minTokens) return { alert: false, reason: 'insufficient-sample' };
  const rate = hitRate(win);
  if (rate === null) return { alert: false, reason: 'no-sample' };
  if (rate >= threshold) return { alert: false, reason: 'healthy' };
  return { alert: true, reason: 'below-threshold', hitRate: rate };
}
