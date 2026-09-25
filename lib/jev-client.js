/**
 * Jev 客户端：TypeSafe System One 决策模型。
 *
 * 端点与请求形状取自官方文档（2026-09 核对）：
 *   POST https://api.typesafe.ai/v1/systemone
 *   { state, model, questions }
 *   → { model, answers: { <id>: {type, ...} }, usage }
 *
 * 硬性设计：任何失败都返回 null 而不抛。判定是可选的加速项，
 * 绝不能因为 Jev 抖动而阻塞用户的首步请求。
 */

export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export class JevClient {
  /**
   * @param {object} options
   * @param {string|undefined} options.apiKey TypeSafe API Key
   * @param {number} [options.timeoutMs] 单次判定超时
   * @param {string} [options.endpoint]
   * @param {string} [options.model]
   * @param {typeof fetch} [options.fetchImpl] 注入用（测试）
   */
  constructor({ apiKey, timeoutMs = 1500, endpoint = DEFAULT_ENDPOINT, model = DEFAULT_MODEL, fetchImpl } = {}) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.endpoint = endpoint;
    this.model = model;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  get configured() {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  /**
   * 发起一次判定。
   *
   * @param {unknown} state 状态（对象更好：官方建议把相关字段各自命名）
   * @param {object} questions 问题集
   * @returns {Promise<object|null>} 解析后的响应体，失败为 null
   */
  async ask(state, questions) {
    if (!this.configured || typeof this.fetchImpl !== 'function') return null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ state, model: this.model, questions }),
        });

        // 429 是官方明确的限流信号，按 Retry-After 退避一次。
        if (response.status === 429 && attempt === 0) {
          const retryAfter = Number(response.headers?.get?.('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 2000) : 250;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        if (!response.ok) return null;
        return await response.json();
      } catch {
        // 超时、网络失败、JSON 解析失败：一律静默降级。
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }
}
