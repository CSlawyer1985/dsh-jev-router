import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, STRUCTURAL_KEYS, isVolatileRef, readConfig, resolveConfig } from '../lib/config.js';

/** 复刻 DSH 的 volatile 引用：Object.freeze({ get: () => current }) */
function volatileRef(value) {
  return Object.freeze({ get: () => value });
}

test('isVolatileRef: 认出 volatile 引用，且不误判普通值', () => {
  assert.equal(isVolatileRef(volatileRef(true)), true);
  assert.equal(isVolatileRef(true), false);
  assert.equal(isVolatileRef('auto'), false);
  assert.equal(isVolatileRef(0.5), false);
  assert.equal(isVolatileRef(['a']), false);
  assert.equal(isVolatileRef([]), false, '空数组没有 get 方法');
  assert.equal(isVolatileRef(null), false);
  assert.equal(isVolatileRef(undefined), false);
});

test('readConfig: 拆掉 volatile 包装', () => {
  const config = {
    modelRouting: volatileRef(true),
    hitRateAlert: volatileRef(0.75),
    effort: volatileRef('low'),
    modelAllowlist: volatileRef(['a', 'b']),
  };
  assert.equal(readConfig(config, 'modelRouting'), true);
  assert.equal(readConfig(config, 'hitRateAlert'), 0.75);
  assert.equal(readConfig(config, 'effort'), 'low');
  assert.deepEqual(readConfig(config, 'modelAllowlist'), ['a', 'b']);
});

test('readConfig: 裸值原样通过（单测与老 host 的形态）', () => {
  const config = { modelRouting: true, effort: 'max' };
  assert.equal(readConfig(config, 'modelRouting'), true);
  assert.equal(readConfig(config, 'effort'), 'max');
});

test('readConfig: 缺失或 undefined/null 时取默认值', () => {
  assert.equal(readConfig({}, 'modelRouting'), DEFAULTS.modelRouting);
  assert.equal(readConfig({ effort: undefined }, 'effort'), DEFAULTS.effort);
  assert.equal(readConfig({ effort: null }, 'effort'), DEFAULTS.effort);
  assert.equal(readConfig(undefined, 'enabled'), DEFAULTS.enabled);
});

test('readConfig: volatile 引用取值抛错时退回默认值，不向上抛', () => {
  const broken = { get: () => { throw new Error('released'); } };
  assert.equal(readConfig({ effort: broken }, 'effort'), DEFAULTS.effort);
});

test('readConfig: volatile 引用内部为 undefined 时退回默认值', () => {
  assert.equal(readConfig({ effort: volatileRef(undefined) }, 'effort'), DEFAULTS.effort);
});

// ── 核心回归：实机启动才暴露的那个 bug ──────────────────────
test('回归：整份配置都是 volatile 引用时，resolveConfig 必须给出裸值', () => {
  // DSH 的 loader 把 volatile 字段作为引用对象交给插件。
  // 修复前：`config.modelRouting === true` 恒为 false（引用对象 !== true），
  // 于是 Tier B 永远打不开、置信度阈值比较得到 NaN。
  const live = {};
  for (const [key, value] of Object.entries(DEFAULTS)) live[key] = volatileRef(value);
  // 模拟用户改过几个值
  live.modelRouting = volatileRef(true);
  live.acknowledgeCacheRisk = volatileRef(true);
  live.effort = volatileRef('max');
  live.hitRateAlert = volatileRef(0.9);

  const resolved = resolveConfig(live);

  assert.equal(resolved.modelRouting, true, 'volatile 包装必须被拆开，否则 Tier B 永远关着');
  assert.equal(resolved.acknowledgeCacheRisk, true);
  assert.equal(resolved.effort, 'max');
  assert.equal(resolved.hitRateAlert, 0.9);

  // 类型必须真的是布尔 / 数字 —— 这正是 `=== true` 与 `<` 比较能生效的前提
  assert.equal(typeof resolved.modelRouting, 'boolean');
  assert.equal(typeof resolved.enabled, 'boolean');
  assert.equal(typeof resolved.confidenceFloor, 'number');
  assert.equal(typeof resolved.stickyRounds, 'number');
  assert.equal(typeof resolved.effort, 'string');
  assert.ok(Array.isArray(resolved.modelAllowlist));

  // 严谨一点：不要留下任何还是引用的字段
  for (const [key, value] of Object.entries(resolved)) {
    assert.equal(isVolatileRef(value), false, `${key} 仍然是引用对象`);
  }
});

test('resolveConfig: 覆盖全部 DEFAULTS 键，且缺省时与 DEFAULTS 一致', () => {
  const resolved = resolveConfig({});
  assert.deepEqual(Object.keys(resolved).sort(), Object.keys(DEFAULTS).sort());
  for (const key of Object.keys(DEFAULTS)) {
    assert.deepEqual(resolved[key], DEFAULTS[key], `${key} 缺省值应与 DEFAULTS 一致`);
  }
});

test('DEFAULTS: 结构性字段集合与 schema 的非 volatile 字段一致', () => {
  // pricingAutoRefreshHours / pricingCachePath / namespace 语义上需要重启才生效，
  // 因此它们不是 volatile；其余字段都必须可运行时修改。
  assert.deepEqual([...STRUCTURAL_KEYS].sort(), ['namespace', 'pricingAutoRefreshHours', 'pricingCachePath']);
  for (const key of STRUCTURAL_KEYS) {
    assert.ok(key in DEFAULTS, `${key} 必须在 DEFAULTS 里`);
  }
});

test('DEFAULTS: 出厂默认是「Tier B 关闭 + 未确认缓存风险」', () => {
  assert.equal(DEFAULTS.modelRouting, false);
  assert.equal(DEFAULTS.acknowledgeCacheRisk, false);
  assert.equal(DEFAULTS.enabled, true, 'Tier A 默认开启');
  assert.equal(DEFAULTS.effort, 'auto');
});
