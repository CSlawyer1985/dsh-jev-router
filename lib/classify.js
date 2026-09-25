/**
 * 判定层：把一条用户消息变成结构化决策。
 *
 * 两条路径：
 *   1. Jev（TypeSafe 决策模型）——语义判定，返回 { effort, risk, urgent } 与置信度。
 *   2. 启发式回退——抄 Claude Code 的关键词表，无语义能力，只在 Jev 不可用时兜底。
 *
 * 设计约束（见 docs/CACHE_SAFETY.md）：
 *   - 判定结果只用于改写 LlmCallConfig，绝不进入 prompt 前缀。
 *   - 置信度低于阈值时弃权，交回 harness 默认档，绝不猜。
 */

/** 推理强度档位。来自 DSH DeepSeek 适配器支持的取值集合。 */
export const EFFORTS = Object.freeze(['off', 'low', 'high', 'max']);

/**
 * Claude Code 的关键词表（用户指定：直接抄）。
 * 语义能力为零，纯字面匹配，仅作 Jev 缺席时的兜底。
 */
export const KEYWORD_TABLE = Object.freeze([
  { pattern: /\bultrathink\b|完整全量思考|彻底思考|穷尽思考|用尽全力/i, effort: 'max' },
  { pattern: /\bmegathink\b|\bthink\s+hard(?:er)?\b|仔细(?:想|思考|分析)|深入思考|好好想想|认真(?:想|分析)/i, effort: 'high' },
  { pattern: /\bthink\b|想一下|思考一下/i, effort: 'high' },
  { pattern: /快速回答|简短回答|简单回答|别想太多|不用想|直接说|快答|\bquickly\b|\bquick answer\b/i, effort: 'low' },
  { pattern: /^(hi|hello|hey|你好|嗨|在吗|谢谢|thanks|thank you)[\s!。,.，]*$/i, effort: 'off' },
]);

/**
 * 构建发给 Jev 的问题集。
 *
 * 注意：官方文档明确「question id 不会发给模型」，模型只看到 instructions 与 criteria，
 * 所以选项描述必须彼此可区分；且 CJK 准确率较低，故 instructions/criteria 全英文，
 * 中文原话放在 state 里（官方建议 state 用对象并各自命名）。
 *
 * @returns {object} systemone 请求体的 questions 字段
 */
export function buildQuestions() {
  return {
    effort: {
      type: 'choice',
      instructions:
        'How much internal reasoning effort should the assistant spend on this request? Judge the request itself, not the assistant persona.',
      criteria: {
        off: 'Trivial: greeting, thanks, plain lookup, or a one-word confirmation. No analysis at all.',
        low: 'Simple and short: a single-step answer, a quick fact, or an explicit demand for a fast short reply.',
        high: 'Substantial: multi-step work, code changes, debugging, or an answer whose error would cost real time or money.',
        max: 'Exhaustive: the user explicitly asks for complete/thorough reasoning, or the decision is high-stakes and irreversible.',
      },
    },
    risk: {
      type: 'score',
      instructions: 'If the assistant answers this request incorrectly, how costly is the mistake?',
      // 官方建议「描述情境而非程度」，纯数字等级会导致概率分散。
      criteria: [
        'No consequence: a trivial or easily corrected reply.',
        'Minor: small rework or a quick follow-up question fixes it.',
        'Serious: wrong code, a broken build, or a misleading conclusion that costs real time.',
        'Severe: an irreversible action, data loss, money, or a production incident.',
      ],
    },
    urgent: {
      type: 'noul',
      instructions: 'Does the user want a fast answer rather than a thorough one?',
    },
  };
}

/**
 * 解析 systemone 响应。
 *
 * ⚠️ 两个 "model" 必须分清，混淆会让模型路由**静默失效**：
 *   - 响应顶层的 `model` 是**作答的 Jev 版本号**（官方示例 `"jev-1.13.0"`）；
 *     即使用别名请求也会返回实际版本，用于日志核对 → 这里叫 `jevModel`。
 *   - `answers.model.choice` 才是**被选中的路由目标模型**（我们自己定义的候选 id）
 *     → 这里叫 `model`。
 *
 * @param {unknown} body 响应体
 * @returns {{effort: string|null, effortConfidence: number, risk: number|null, urgent: number|null, model: string|null, jevModel: string|null}}
 */
export function parseDecision(body) {
  const answers = body && typeof body === 'object' ? body.answers : undefined;
  const effort = answers && typeof answers === 'object' ? answers.effort : undefined;

  let choice = null;
  let confidence = 0;
  if (effort && typeof effort === 'object') {
    if (typeof effort.choice === 'string' && EFFORTS.includes(effort.choice)) choice = effort.choice;
    if (typeof effort.confidence === 'number' && Number.isFinite(effort.confidence)) {
      confidence = Math.min(1, Math.max(0, effort.confidence));
    }
  }

  const riskAnswer = answers && typeof answers === 'object' ? answers.risk : undefined;
  const risk =
    riskAnswer && typeof riskAnswer === 'object' && typeof riskAnswer.score === 'number'
      ? riskAnswer.score
      : null;

  const urgentAnswer = answers && typeof answers === 'object' ? answers.urgent : undefined;
  const urgent =
    urgentAnswer && typeof urgentAnswer === 'object' && typeof urgentAnswer.noul === 'number'
      ? urgentAnswer.noul
      : null;

  // 路由目标：只认 answers.model.choice，绝不能用顶层的版本号。
  const modelAnswer = answers && typeof answers === 'object' ? answers.model : undefined;
  const routed =
    modelAnswer &&
    typeof modelAnswer === 'object' &&
    typeof modelAnswer.choice === 'string' &&
    modelAnswer.choice.length > 0
      ? modelAnswer.choice
      : null;

  return {
    effort: choice,
    effortConfidence: confidence,
    risk,
    urgent,
    model: routed,
    jevModel: body && typeof body === 'object' && typeof body.model === 'string' ? body.model : null,
  };
}

/**
 * 启发式兜底：关键词字面匹配。
 *
 * 已知缺陷（有意保留并由文档承认）：无法处理语义反转，例如
 * 「请快速回答，不要完整全量思考」会同时命中 max 与 low 两组关键词。
 * 因此先判 low（快速类），再判高强度类——快速意图更明确。
 *
 * @param {string} text 用户原话
 * @param {string} fallback 无命中时的档位
 * @returns {{effort: string, matched: string|null}}
 */
export function heuristicEffort(text, fallback = 'high') {
  const input = typeof text === 'string' ? text : '';
  if (input.trim().length === 0) return { effort: fallback, matched: null };

  const fast = KEYWORD_TABLE.find((entry) => entry.effort === 'low' && entry.pattern.test(input));
  if (fast) return { effort: 'low', matched: 'quick' };

  const trivial = KEYWORD_TABLE.find((entry) => entry.effort === 'off' && entry.pattern.test(input));
  if (trivial) return { effort: 'off', matched: 'trivial' };

  for (const entry of KEYWORD_TABLE) {
    if (entry.effort === 'off' || entry.effort === 'low') continue;
    if (entry.pattern.test(input)) return { effort: entry.effort, matched: String(entry.pattern) };
  }
  return { effort: fallback, matched: null };
}

/**
 * 从 harness 的 UserMessage 中取出纯文本。
 *
 * @param {unknown} message
 * @returns {string}
 */
export function extractUserText(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    // 忽略图片/文件块：Jev 只接受文本（官方限制）。
  }
  return parts.join('\n').trim();
}
