import test from 'node:test';
import assert from 'node:assert/strict';

import { createMetrics, recordUsage, hitRate, snapshot, shouldAlert } from '../lib/metrics.js';

const PRICE = { hit: 0.044, miss: 1.32, out: 3.96 };

test('hitRate: 无样本时返回 null（不显示误导性的 0%）', () => {
  assert.equal(hitRate({ cacheReadTokens: 0, inputTokens: 0 }), null);
});

test('recordUsage + snapshot: 复刻用户真实会话的字段与量级', () => {
  const metrics = createMetrics();
  // 取自用户真实会话日志的一步：绝大多数输入来自缓存。
  recordUsage(metrics, { inputTokens: 1959, outputTokens: 3873, cacheReadTokens: 167296, reasoningTokens: 1959 }, { model: 'deepseek-v4-flash' });
  recordUsage(metrics, { inputTokens: 576, outputTokens: 2698, cacheReadTokens: 164096, reasoningTokens: 2512 }, { model: 'deepseek-v4-flash' });

  const stats = snapshot(metrics, PRICE);
  assert.equal(stats.steps, 2);
  assert.equal(stats.inputTokens, 2535);
  assert.equal(stats.cacheReadTokens, 331392);
  assert.equal(stats.outputTokens, 6571);
  assert.equal(stats.reasoningTokens, 4471);

  const expected = 331392 / (331392 + 2535);
  assert.ok(Math.abs(stats.hitRate - expected) < 1e-9);
  assert.ok(stats.hitRate > 0.99, `命中率应 >99%，实际 ${stats.hitRate}`);

  // 缓存省下的钱 = 命中的 token × (miss - hit)
  const expectedSaving = (331392 * (1.32 - 0.044)) / 1e6;
  assert.ok(Math.abs(stats.cacheSavingUsd - expectedSaving) < 1e-9);
});

test('snapshot: reasoning 占比与平均 reasoning token', () => {
  const metrics = createMetrics();
  recordUsage(metrics, { inputTokens: 100, outputTokens: 1000, cacheReadTokens: 900, reasoningTokens: 400 });
  recordUsage(metrics, { inputTokens: 100, outputTokens: 1000, cacheReadTokens: 900, reasoningTokens: 600 });

  const stats = snapshot(metrics, null);
  assert.equal(stats.reasoningShare, 0.5);
  assert.equal(stats.avgReasoningTokens, 500);
  assert.equal(stats.cacheSavingUsd, null, '未给价格时不给金钱数字');
});

test('recordUsage: 负数与脏值被忽略', () => {
  const metrics = createMetrics();
  recordUsage(metrics, { inputTokens: -5, outputTokens: 'x', cacheReadTokens: null, reasoningTokens: undefined });
  const stats = snapshot(metrics, null);
  assert.equal(stats.inputTokens, 0);
  assert.equal(stats.outputTokens, 0);
  recordUsage(metrics, null);
  assert.equal(metrics.steps, 1);
});

test('shouldAlert: 样本不足时不告警（避免冷启动误报）', () => {
  const metrics = createMetrics();
  recordUsage(metrics, { inputTokens: 100, cacheReadTokens: 100, outputTokens: 10, reasoningTokens: 0 });
  const verdict = shouldAlert({ metrics, threshold: 0.8 });
  assert.equal(verdict.alert, false);
  assert.equal(verdict.reason, 'insufficient-sample');
});

test('shouldAlert: 命中率跌破阈值且样本充足时告警', () => {
  const metrics = createMetrics();
  // 命中率 50%，样本量超过 20K
  recordUsage(metrics, { inputTokens: 20000, cacheReadTokens: 20000, outputTokens: 100, reasoningTokens: 0 });
  const verdict = shouldAlert({ metrics, threshold: 0.8 });
  assert.equal(verdict.alert, true);
  assert.equal(verdict.reason, 'below-threshold');
  assert.ok(Math.abs(verdict.hitRate - 0.5) < 1e-9);
});

test('shouldAlert: 命中率健康时不告警', () => {
  const metrics = createMetrics();
  recordUsage(metrics, { inputTokens: 200, cacheReadTokens: 200000, outputTokens: 100, reasoningTokens: 0 });
  assert.equal(shouldAlert({ metrics, threshold: 0.8 }).alert, false);
});

test('窗口命中率与累计命中率是两件事（长上下文会主导累计值）', () => {
  const metrics = createMetrics({ windowSize: 2 });
  // 三步：第一步全冷且极长，后两步短且全命中
  recordUsage(metrics, { inputTokens: 100000, cacheReadTokens: 0, outputTokens: 10, reasoningTokens: 0 });
  recordUsage(metrics, { inputTokens: 10, cacheReadTokens: 900, outputTokens: 10, reasoningTokens: 0 });
  recordUsage(metrics, { inputTokens: 10, cacheReadTokens: 900, outputTokens: 10, reasoningTokens: 0 });

  const stats = snapshot(metrics, null);
  assert.ok(stats.hitRate < 0.02, `累计命中率应被冷启动主导，实际 ${stats.hitRate}`);
  assert.ok(stats.windowHitRate > 0.98, `窗口命中率应为高位，实际 ${stats.windowHitRate}`);
});

// ── reasoningTokens 的上报与否 ──────────────────────────────
test('回归：provider 不上报 reasoningTokens 时，占比必须是 null 而不是 0', () => {
  // 实测：当前 DSH 版本里没有任何适配器填充 reasoningTokens。
  // 若把「0」当成「没有思考」，界面会长期显示一个假的 0%。
  const metrics = createMetrics();
  recordUsage(metrics, { inputTokens: 100, cacheReadTokens: 900, outputTokens: 500 });
  recordUsage(metrics, { inputTokens: 100, cacheReadTokens: 900, outputTokens: 500 });

  const stats = snapshot(metrics, null);
  assert.equal(stats.reasoningReported, false, '从未上报过 → 标志为 false');
  assert.equal(stats.reasoningShare, null, '未上报时占比必须为 null，界面才能显示「未上报」');
  assert.equal(stats.reasoningTokens, 0, '累计值仍是 0（它确实没被上报）');
});

test('provider 明确上报 0 时，与「不上报」要区分开', () => {
  const metrics = createMetrics();
  recordUsage(metrics, { inputTokens: 100, cacheReadTokens: 900, outputTokens: 500, reasoningTokens: 0 });

  const stats = snapshot(metrics, null);
  assert.equal(stats.reasoningReported, true, '字段存在（哪怕是 0）就算上报');
  assert.equal(stats.reasoningShare, 0, '上报了 0 就该显示 0%');
});

test('一旦某次上报过，后续未带该字段的调用不会把标志打回去', () => {
  const metrics = createMetrics();
  recordUsage(metrics, { inputTokens: 10, cacheReadTokens: 90, outputTokens: 100, reasoningTokens: 40 });
  recordUsage(metrics, { inputTokens: 10, cacheReadTokens: 90, outputTokens: 100 });

  const stats = snapshot(metrics, null);
  assert.equal(stats.reasoningReported, true);
  assert.equal(stats.reasoningShare, 40 / 200);
});
