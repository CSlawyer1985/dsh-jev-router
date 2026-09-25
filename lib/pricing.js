/**
 * 价格模块：从 DeepSeek 官网获取价目，支持刷新，带快照回退。
 *
 * 权威来源：https://api-docs.deepseek.com/quick_start/pricing
 * 官方说明要点（2026-09 核对）：
 *   - 价格单位为 $/1M tokens，命中/未命中/输出三档分列 peak 与 off-peak。
 *   - off-peak 是 peak 的一半。
 *   - peak 时段：UTC 周一至周五 01:00-04:00 与 06:00-10:00，中国法定节假日除外。
 *   - `deepseek-v4-flash` 等旧名仍被接受，但由 V4.1-Flash 服务并按 Flash 价计费。
 *
 * 设计：网络获取失败时**绝不**抛错，回退到内置快照并把来源标记为 snapshot。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing';

/** 内置快照：2026-09-25 取自官网。用于离线与解析失败时的回退。 */
export const SNAPSHOT = Object.freeze({
  source: 'snapshot',
  url: PRICING_URL,
  fetchedAt: '2026-09-25',
  models: {
    'deepseek-flash': {
      hit: { offpeak: 0.003, peak: 0.006 },
      miss: { offpeak: 0.15, peak: 0.3 },
      out: { offpeak: 0.6, peak: 1.2 },
    },
    'deepseek-v4-pro': {
      hit: { offpeak: 0.022, peak: 0.044 },
      miss: { offpeak: 0.66, peak: 1.32 },
      out: { offpeak: 1.98, peak: 3.96 },
    },
  },
});

/** 旧名 → 官网模型键。 */
const ALIASES = Object.freeze({
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
});

function stripTags(html) {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function cellsOf(rowHtml) {
  return [...String(rowHtml).matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => stripTags(m[1]));
}

function normalizeModelKey(cell) {
  const match = String(cell).match(/deepseek[-a-z0-9.]*/i);
  return match ? match[0].toLowerCase().replace(/\.$/, '') : null;
}

/**
 * 从官网 HTML 解析价目表。
 *
 * 结构上有 rowspan：`1M INPUT TOKENS (CACHE HIT)` 只出现在该组第一行，
 * 后续 `PEAK` 行不带种类单元格。因此按行扫描并**沿用上一次的种类/时段**。
 *
 * @param {string} html
 * @returns {{models: object, source: string, url: string}|null} 解析失败返回 null
 */
export function parsePricingTable(html) {
  if (typeof html !== 'string' || html.length === 0) return null;

  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => cellsOf(m[1]))
    .filter((row) => row.length > 0);
  if (rows.length === 0) return null;

  let models = [];
  for (const row of rows) {
    const index = row.findIndex((cell) => /^model$/i.test(cell));
    if (index >= 0) {
      models = row
        .slice(index + 1)
        .map(normalizeModelKey)
        .filter(Boolean);
      if (models.length > 0) break;
    }
  }
  if (models.length === 0) return null;

  const acc = {};
  for (const model of models) {
    acc[model] = { hit: {}, miss: {}, out: {} };
  }

  let kind = null;
  let period = null;
  for (const row of rows) {
    const joined = row.join(' | ');
    if (/input tokens/i.test(joined) && /cache hit/i.test(joined)) kind = 'hit';
    else if (/input tokens/i.test(joined) && /cache miss/i.test(joined)) kind = 'miss';
    else if (/output tokens/i.test(joined)) kind = 'out';

    if (row.some((cell) => /^off-?peak$/i.test(cell))) period = 'offpeak';
    else if (row.some((cell) => /^peak$/i.test(cell))) period = 'peak';

    const prices = row
      .filter((cell) => /^\$/.test(cell))
      .map((cell) => Number(cell.replace(/[^0-9.]/g, '')));
    if (kind === null || period === null || prices.length === 0) continue;

    prices.forEach((price, index) => {
      const model = models[index];
      if (!model || !Number.isFinite(price)) return;
      acc[model][kind][period] = price;
    });
  }

  // 完整性校验：至少一个模型三档齐备，否则认为页面结构变了。
  const complete = Object.values(acc).some(
    (entry) =>
      ['hit', 'miss', 'out'].every(
        (k) => Number.isFinite(entry[k].peak) && Number.isFinite(entry[k].offpeak),
      ),
  );
  if (!complete) return null;

  return { models: acc, source: 'official', url: PRICING_URL, fetchedAt: new Date().toISOString() };
}

/**
 * 从官网抓取并解析价目。
 * @returns {Promise<object|null>} 失败返回 null（调用方回退快照）
 */
export async function fetchOfficialPricing({ fetchImpl, timeoutMs = 4000 } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(PRICING_URL, { signal: controller.signal });
    if (!response.ok) return null;
    return parsePricingTable(await response.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 是否处于 peak 计费时段。
 *
 * 中国法定节假日无法本地推算，通过 holidays 显式传入（YYYY-MM-DD）；
 * 判断不出来时按 peak 计（更贵的一侧），让成本估算偏保守。
 */
export function isPeak(date = new Date(), { holidays = [] } = {}) {
  const day = date.getUTCDay();
  const key = date.toISOString().slice(0, 10);
  if (Array.isArray(holidays) && holidays.includes(key)) return false;
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

function resolveModelKey(pricing, modelId) {
  const id = String(modelId ?? '').toLowerCase();
  if (ALIASES[id] && pricing.models[ALIASES[id]]) return ALIASES[id];
  if (pricing.models[id]) return id;
  // 模糊匹配：取在 id 中出现的最长模型键（覆盖 flash/pro 两类）。
  const candidates = Object.keys(pricing.models)
    .filter((key) => id.includes(key))
    .sort((a, b) => b.length - a.length);
  if (candidates.length > 0) return candidates[0];
  if (/flash/.test(id)) return 'deepseek-flash';
  if (/pro/.test(id)) return 'deepseek-v4-pro';
  return null;
}

/**
 * 取某个模型在当前时段的单价。
 * @returns {{hit:number,miss:number,out:number,period:'peak'|'offpeak',model:string,exact:boolean}|null}
 */
export function priceFor(pricing, modelId, { date = new Date(), holidays = [] } = {}) {
  if (!pricing || !pricing.models) return null;
  const key = resolveModelKey(pricing, modelId);
  if (!key || !pricing.models[key]) return null;
  const entry = pricing.models[key];
  const period = isPeak(date, { holidays }) ? 'peak' : 'offpeak';
  const hit = entry.hit?.[period];
  const miss = entry.miss?.[period];
  const out = entry.out?.[period];
  if (![hit, miss, out].every(Number.isFinite)) return null;
  return { hit, miss, out, period, model: key, exact: String(modelId ?? '').toLowerCase() === key };
}

/**
 * 磁盘缓存包装：读缓存 → 过期则刷新 → 失败回退快照。
 */
export function createPricingStore({ cachePath, ttlHours = 24 } = {}) {
  let cached = null;

  async function load() {
    if (!cachePath) return null;
    try {
      const raw = await readFile(cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.models) return parsed;
    } catch {
      /* 首次运行没有缓存文件，属正常 */
    }
    return null;
  }

  async function save(value) {
    if (!cachePath) return;
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(value, null, 2), 'utf8');
    } catch {
      /* 缓存写失败不影响功能 */
    }
  }

  return {
    /** 当前价目（内存 → 磁盘 → 快照）。 */
    async current() {
      if (cached) return cached;
      cached = (await load()) ?? { ...SNAPSHOT };
      return cached;
    },

    /** 强制刷新（供 /jev pricing refresh 与启动预热）。 */
    async refresh({ fetchImpl } = {}) {
      const fetched = await fetchOfficialPricing({ fetchImpl });
      if (!fetched) {
        cached = (await load()) ?? { ...SNAPSHOT };
        return { ok: false, pricing: cached, reason: 'fetch-or-parse-failed' };
      }
      cached = fetched;
      await save(fetched);
      return { ok: true, pricing: cached, reason: 'refreshed' };
    },

    /** 缓存是否过期（供自动刷新）。 */
    async stale(now = Date.now()) {
      const value = await this.current();
      if (!value?.fetchedAt) return true;
      const at = Date.parse(value.fetchedAt);
      if (!Number.isFinite(at)) return true;
      return now - at > ttlHours * 3600 * 1000;
    },
  };
}

/**
 * 解析用户自备价目。
 *
 * 官网只提供 DeepSeek 的价目，但模型路由可能指向别的 provider
 * （OpenAI / Kimi / 本地 ollama…）。没有价格就无法计算破缓存的代价，
 * 成本闸会一律拒绝——这是安全的默认，但会让多 provider 路由不可用。
 * 因此允许用户手工补价：
 *
 *   条目格式：`provider::model=命中,未命中,输出`（USD / 1M tokens）
 *   也接受不限定 provider 的 `::model=...`
 *
 * 非 DeepSeek 的 provider 没有 peak/off-peak 之分，所以这组价格同时用于两个时段。
 *
 * @param {readonly string[]|undefined} entries
 * @returns {Map<string, {hit:number, miss:number, out:number}>}
 */
export function parseCustomPricing(entries) {
  const table = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const raw = String(entry ?? '').trim();
    if (raw.length === 0) continue;
    const separator = raw.indexOf('=');
    if (separator <= 0) continue;
    const key = raw.slice(0, separator).trim();
    const numbers = raw
      .slice(separator + 1)
      .split(',')
      .map((value) => Number(value.trim()));
    if (key.length === 0) continue;
    if (numbers.length !== 3) continue;
    if (!numbers.every((value) => Number.isFinite(value) && value >= 0)) continue;
    table.set(key, { hit: numbers[0], miss: numbers[1], out: numbers[2] });
  }
  return table;
}

/**
 * 从自备价目表里取某个路由的价格。
 * @returns {{hit:number, miss:number, out:number, period:'custom', model:string, exact:boolean}|null}
 */
export function customPriceFor(table, provider, model) {
  if (!table || typeof table.get !== 'function' || table.size === 0) return null;
  const id = String(model ?? '');
  const price = table.get(`${provider}::${id}`) ?? table.get(`::${id}`);
  if (!price) return null;
  return { hit: price.hit, miss: price.miss, out: price.out, period: 'custom', model: id, exact: true };
}
