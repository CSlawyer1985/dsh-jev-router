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
    this.lastError = null;
    if (!this.configured) {
      // 必须记原因：否则「没配 Key」和「请求失败」在界面上无法区分，
      // 用户只会看到"能力没生效"。
      this.lastError = { kind: 'not-configured' };
      return null;
    }
    if (typeof this.fetchImpl !== 'function') {
      this.lastError = { kind: 'no-fetch' };
      return null;
    }

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
        if (!response.ok) {
          // 把失败写进 lastError：静默降级在生产里等于"功能莫名失效"，
          // 本插件已经因为不可观测踩过一次坑，不再重犯。
          this.lastError = { kind: 'http', status: response.status, attempt };
          return null;
        }
        try {
          return await response.json();
        } catch {
          this.lastError = { kind: 'parse', attempt };
          return null;
        }
      } catch (error) {
        // 超时 / 网络失败。区分开 abort 与其他错误，便于定位。
        const aborted = error?.name === 'AbortError' || /abort/i.test(String(error?.message ?? ''));
        this.lastError = {
          kind: aborted ? 'timeout' : 'network',
          timeoutMs: this.timeoutMs,
          attempt,
          message: String(error?.message ?? error),
        };
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }
}
