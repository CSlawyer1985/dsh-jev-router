/**
 * 模型能力适配层。
 *
 * 为什么需要它：DSH 的 `llm` 服务对不支持的推理强度是**硬拒绝**，
 * 明确写着 "no clamping or aliasing is performed"（见 resolveCallConfig 文档）。
 * 本插件原先硬编码 DeepSeek 的 `off|low|high|max`，一旦用户的会话跑在
 * OpenAI（`minimal|low|medium|high`）或 Anthropic（`low|medium|high|xhigh|max`）
 * 上，写入一个不支持的档位会让**整个请求失败**。
 *
 * 这里做两件事：
 *   1. 向模型注册表问它到底支持哪些档位（`llm.resolveModelInfo`）；
 *   2. 把判定结果**夹取**到最近的受支持档位，而不是原样透传。
 *
 * 纯函数部分（rankOf / clampEffort / parseAllowlistEntry）单独导出以便单测。
 */

/**
 * 档位的「内在强度」评分表。
 *
 * 各家命名不同，但语义可以对齐到一条强度轴：
 *   off/none/disabled  <  minimal/low  <  medium  <  high  <  xhigh/max
 * 未识别的名字按 high（2）处理——宁可当成中等强度，也不要误判成最高档。
 */
const EFFORT_RANK = Object.freeze({
  off: 0,
  none: 0,
  disabled: 0,
  minimal: 1,
  low: 1,
  medium: 1.5,
  high: 2,
  xhigh: 3,
  max: 3,
});

/** 未识别档位的兜底强度。 */
export const UNKNOWN_RANK = 2;

/**
 * 取一个档位名的内在强度。
 * @returns {number}
 */
export function rankOf(effort) {
  const key = String(effort ?? '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(EFFORT_RANK, key) ? EFFORT_RANK[key] : UNKNOWN_RANK;
}

/**
 * 把判定出的档位夹取到模型真正支持的档位集合。
 *
 * 规则：取强度轴上距离最近的那个；距离相同时取**更强**的那个
 * （适配器的档位列表按升序排列，所以「更靠后」即更强）。
 * 宁可多花一点，也不要因为夹取过猛而让答案质量塌掉。
 *
 * @param {string} decided 判定出的档位
 * @param {readonly string[]|null|undefined} supported 模型支持的档位
 * @returns {{effort: string|null, clamped: boolean, reason: string}}
 */
export function clampEffort(decided, supported) {
  if (!Array.isArray(supported) || supported.length === 0) {
    // 模型没有推理元数据：一个档位都不能设，原样交回 harness 默认。
    return { effort: null, clamped: false, reason: 'no-reasoning-support' };
  }
  if (supported.includes(decided)) {
    return { effort: decided, clamped: false, reason: 'exact' };
  }

  const target = rankOf(decided);
  const ranks = supported.map(rankOf);
  const floor = Math.min(...ranks);
  const ceiling = Math.max(...ranks);

  // 低于模型的下界：取最省的那一档（不要擅自升级到更贵的位置）。
  if (target <= floor) {
    const index = ranks.indexOf(floor);
    return { effort: supported[index], clamped: true, reason: `clamped(${decided}->${supported[index]})` };
  }
  // 高于模型的上界：取最强的那一档。
  if (target >= ceiling) {
    const index = ranks.lastIndexOf(ceiling);
    return { effort: supported[index], clamped: true, reason: `clamped(${decided}->${supported[index]})` };
  }

  // 落在区间内：取距离最近的；等距时取更强的一侧（宁可多花，不可塌质量）。
  let best = null;
  for (let i = 0; i < supported.length; i += 1) {
    const rank = ranks[i];
    const distance = Math.abs(rank - target);
    if (best === null || distance < best.distance || (distance === best.distance && rank >= best.rank)) {
      best = { effort: supported[i], rank, distance };
    }
  }
  return { effort: best.effort, clamped: true, reason: `clamped(${decided}->${best.effort})` };
}

/**
 * 解析白名单条目。
 *
 * 用 `provider::model` 显式指定 provider——不能用 `provider/model`，
 * 因为真实的模型 id 里就带斜杠（例如 ollama 的
 * `orcarouter/Qwen3.8-27B-Uncensored:q5_K_M`），也无法用单个冒号，
 * 因为 ollama 的 tag 就是冒号形式。双冒号在模型 id 里不会出现。
 *
 * @param {string} entry
 * @returns {{provider: string|undefined, model: string, raw: string}|null}
 */
export function parseAllowlistEntry(entry) {
  const raw = String(entry ?? '').trim();
  if (raw.length === 0) return null;
  const separator = raw.indexOf('::');
  if (separator === 0) {
    // `::model` 少了 provider，是写法错误而不是一个奇怪的模型名。
    return null;
  }
  if (separator > 0) {
    const provider = raw.slice(0, separator).trim();
    const model = raw.slice(separator + 2).trim();
    if (provider.length === 0 || model.length === 0) return null;
    return { provider, model, raw };
  }
  return { provider: undefined, model: raw, raw };
}

/**
 * 模型能力缓存。
 *
 * 正面结果（能解析、支持的档位集合）可以长期缓存——模型能力是静态的。
 * 负面结果只缓存很短时间：新加的 provider 可能在启动后几秒才挂上适配器，
 * 把一次瞬时的解析失败永久记成「不可用」会误伤。
 *
 * @param {object} input
 * @param {(provider: string, model: string) => Promise<object>} input.resolveModelInfo
 * @param {number} [input.negativeTtlMs]
 */
export function createCapabilityCache({ resolveModelInfo, negativeTtlMs = 30_000, maxEntries = 128 } = {}) {
  /** @type {Map<string, {resolvable: boolean, supported: string[]|null, at: number}>} */
  const cache = new Map();

  function remember(key, value) {
    if (cache.size >= maxEntries) {
      // 简单的 FIFO 淘汰：能力缓存不值得为它引入 LRU 结构。
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
  }

  return {
    /**
     * 问出某个路由的推理能力。
     * @returns {Promise<{resolvable: boolean, supported: string[]|null, cached: boolean}>}
     */
    async capabilities(provider, model) {
      const key = `${provider}::${model}`;
      const hit = cache.get(key);
      if (hit && (hit.resolvable || Date.now() - hit.at < negativeTtlMs)) {
        return { resolvable: hit.resolvable, supported: hit.supported, cached: true };
      }
      if (typeof resolveModelInfo !== 'function') {
        return { resolvable: false, supported: null, cached: false };
      }
      try {
        const info = await resolveModelInfo(provider, model);
        const efforts = info?.reasoning?.efforts;
        const supported =
          Array.isArray(efforts) && efforts.length > 0
            ? efforts.map((e) => (typeof e === 'string' ? e : e?.id)).filter((id) => typeof id === 'string')
            : null;
        remember(key, { resolvable: true, supported, at: Date.now() });
        return { resolvable: true, supported, cached: false };
      } catch {
        remember(key, { resolvable: false, supported: null, at: Date.now() });
        return { resolvable: false, supported: null, cached: false };
      }
    },

    /** 只测试路由是否存在（用于校验模型路由候选）。 */
    async isResolvable(provider, model) {
      const result = await this.capabilities(provider, model);
      return result.resolvable;
    },

    /** 仅供测试与诊断。 */
    get size() {
      return cache.size;
    },
  };
}
