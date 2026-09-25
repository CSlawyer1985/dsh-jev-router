import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePricingTable,
  isPeak,
  priceFor,
  parseCustomPricing,
  customPriceFor,
  SNAPSHOT,
} from '../lib/pricing.js';

/** 复刻官网表格结构（含 rowspan 造成的列错位）。 */
const OFFICIAL_HTML = `
<table><tbody>
<tr><th>MODEL</th><th>deepseek-flash(1)</th><th>deepseek-v4-pro</th></tr>
<tr><td rowspan="6">PRICING(2)</td><td>1M INPUT TOKENS (CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
<tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
<tr><td>1M INPUT TOKENS (CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
<tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
<tr><td>1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
<tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>
</tbody></table>`;

test('parsePricingTable: 正确解析 rowspan 错位下的三档价格', () => {
  const parsed = parsePricingTable(OFFICIAL_HTML);
  assert.ok(parsed, '应当解析成功');
  assert.deepEqual(Object.keys(parsed.models).sort(), ['deepseek-flash', 'deepseek-v4-pro']);

  assert.deepEqual(parsed.models['deepseek-flash'], {
    hit: { offpeak: 0.003, peak: 0.006 },
    miss: { offpeak: 0.15, peak: 0.3 },
    out: { offpeak: 0.6, peak: 1.2 },
  });
  assert.deepEqual(parsed.models['deepseek-v4-pro'], {
    hit: { offpeak: 0.022, peak: 0.044 },
    miss: { offpeak: 0.66, peak: 1.32 },
    out: { offpeak: 1.98, peak: 3.96 },
  });
});

test('parsePricingTable: 结构不认识时返回 null（绝不猜价格）', () => {
  assert.equal(parsePricingTable('<table><tr><td>hello</td></tr></table>'), null);
  assert.equal(parsePricingTable(''), null);
  assert.equal(parsePricingTable(undefined), null);
});

test('内置快照与官网一致（防止快照漂移）', () => {
  const parsed = parsePricingTable(OFFICIAL_HTML);
  assert.deepEqual(SNAPSHOT.models, parsed.models);
});

test('isPeak: 峰值时段为 UTC 周一至周五 01-04 与 06-10', () => {
  // 2026-09-25 是周五
  assert.equal(isPeak(new Date(Date.UTC(2026, 8, 25, 2, 0))), true, '周五 02:00 UTC 应为峰值');
  assert.equal(isPeak(new Date(Date.UTC(2026, 8, 25, 7, 0))), true, '周五 07:00 UTC 应为峰值');
  assert.equal(isPeak(new Date(Date.UTC(2026, 8, 25, 5, 0))), false, '周五 05:00 UTC 应为非峰值');
  assert.equal(isPeak(new Date(Date.UTC(2026, 8, 25, 12, 0))), false, '周五 12:00 UTC 应为非峰值');
  // 2026-09-26 是周六
  assert.equal(isPeak(new Date(Date.UTC(2026, 8, 26, 2, 0))), false, '周末全天非峰值');
});

test('isPeak: 法定节假日按非峰值处理', () => {
  const date = new Date(Date.UTC(2026, 8, 25, 2, 0));
  assert.equal(isPeak(date, { holidays: ['2026-09-25'] }), false);
});

test('priceFor: 旧模型名映射到官网模型键', () => {
  const price = priceFor(SNAPSHOT, 'deepseek-v4-flash', { date: new Date(Date.UTC(2026, 8, 25, 2, 0)) });
  assert.ok(price);
  assert.equal(price.model, 'deepseek-flash');
  assert.equal(price.period, 'peak');
  assert.equal(price.hit, 0.006);
  assert.equal(price.miss, 0.3);
  assert.equal(price.out, 1.2);
});

test('priceFor: pro 模型在非峰值时段取半价', () => {
  const price = priceFor(SNAPSHOT, 'deepseek-v4-pro', { date: new Date(Date.UTC(2026, 8, 25, 12, 0)) });
  assert.equal(price.period, 'offpeak');
  assert.equal(price.out, 1.98);
});

test('priceFor: 不认识的模型返回 null（调用方据此拒绝切换）', () => {
  assert.equal(priceFor(SNAPSHOT, 'gpt-5.6-luna', { date: new Date() }), null);
  assert.equal(priceFor(null, 'deepseek-flash'), null);
});

// ── 自备价目（非 DeepSeek 模型） ─────────────────────────────

test('parseCustomPricing: 解析 provider::model=hit,miss,out', () => {
  const table = parseCustomPricing([
    'openai-codex::gpt-5.6-luna=0.1,0.5,2',
    'ollama::qwen3.8:latest=0,0,0',
    '::global-model=1,2,3',
  ]);
  assert.equal(table.size, 3);
  assert.deepEqual(table.get('openai-codex::gpt-5.6-luna'), { hit: 0.1, miss: 0.5, out: 2 });
  assert.deepEqual(table.get('ollama::qwen3.8:latest'), { hit: 0, miss: 0, out: 0 });
});

test('parseCustomPricing: 畸形条目被跳过而不是猜值', () => {
  const table = parseCustomPricing([
    '',
    'no-equals-sign',
    'a::b=1,2',
    'a::b=1,2,3,4',
    'a::b=x,y,z',
    'a::b=-1,2,3',
    '=1,2,3',
    null,
  ]);
  assert.equal(table.size, 0);
});

test('customPriceFor: provider 精确匹配优先，其次是不限 provider 的条目', () => {
  const table = parseCustomPricing(['openai-codex::m=0.1,0.5,2', '::m=9,9,9', '::other=1,1,1']);
  assert.equal(customPriceFor(table, 'openai-codex', 'm').out, 2);
  assert.equal(customPriceFor(table, 'kimi-coding', 'm').out, 9);
  assert.equal(customPriceFor(table, 'kimi-coding', 'unknown'), null);
});

test('customPriceFor: 空表或缺失时返回 null（调用方据此拒绝切换）', () => {
  assert.equal(customPriceFor(parseCustomPricing([]), 'p', 'm'), null);
  assert.equal(customPriceFor(null, 'p', 'm'), null);
  assert.equal(customPriceFor(undefined, 'p', 'm'), null);
});
