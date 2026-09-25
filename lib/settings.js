/**
 * 插件配置（schemastery schema）与设置页接线。
 *
 * 配置本身就是设置页：DSH 的 settings 服务把本插件的 Config schema 投影成表单，
 * 因此所有开关都出现在「设置 → 插件」里，无需手写表单。
 *
 * 两个必须遵守的 DSH 约定：
 *   1. 运行时可改的字段必须标注 `.volatile()`。DSH 拒绝写入非 volatile 字段
 *      （报错：Plugin entry "…" has no volatile fields），因为非 volatile 字段
 *      语义上是「需要重启才生效」的结构性配置。
 *   2. schema 库用顶层 await + try/catch 加载。本插件以 link/file 方式安装时，
 *      `@deepseek-ai/*` 的解析依赖宿主注入的内存解析钩子；缺失时退化为
 *      「没有 schema」——插件其余功能照常，只是设置页不自动生成。
 *
 * 作者标识：chenshi.ai
 */

import { AUTHOR, AUTHOR_URL, DEFAULT_NAMESPACE } from './namespace.js';
import { DEFAULTS } from './config.js';

let z = null;
try {
  const mod = await import('@deepseek-ai/schemastery');
  z = mod.default ?? mod;
} catch {
  z = null;
}

export { AUTHOR, AUTHOR_URL, DEFAULT_NAMESPACE };

/** 缓存风险的量化提醒文本——出现在设置页字段说明与启用确认里。 */
export const CACHE_RISK_NOTICE = [
  '自动模型路由会在会话中途更换模型。跨模型没有缓存复用：',
  'DSH 在回放历史时会丢弃 thinking 块的 signature（跨模型 signature 不可移植），',
  '这会重写已缓存的会话前缀，命中率会从 ~99% 掉到冷启动水平。',
  '盈亏平衡：破一次缓存需要省下超过「前缀长度 1/3」的输出 token 才回本；',
  '典型思考预算在 1–8K token，而 50K 前缀意味着要省 16K —— 通常不回本。',
  '因此本开关默认关闭，且必须同时勾选「我已理解缓存风险」才会真正生效。',
].join('\n');

/**
 * 构建配置 schema。
 *
 * 没有 schemastery 时返回 undefined —— Cordis 会跳过 config 校验，
 * 插件仍按 loader 传入的对象工作。
 */
function buildConfig() {
  if (!z) return undefined;
  const tunable = (schema, description) => schema.volatile().description(description);

  return z.object({
    // ── 总开关 ──────────────────────────────────────────────
    enabled: tunable(
      z.boolean().default(DEFAULTS.enabled),
      '总开关：启用 Jev 自动思考强度路由。这是缓存安全的档位（只改 reasoningEffort，不碰模型、不碰 prompt 前缀）。',
    ),

    // ── Tier A：思考强度 ────────────────────────────────────
    effort: tunable(
      z.string().default(DEFAULTS.effort),
      '手动钉死思考强度：auto（交给 Jev 判定）| off | low | high | max。手动值永远压过自动判定。',
    ),
    confidenceFloor: tunable(
      z.number().min(0).max(1).default(DEFAULTS.confidenceFloor),
      'Jev 置信度低于此值时弃权，沿用 harness 默认档。宁可不动，也不猜。',
    ),
    fallbackEffort: tunable(
      z.string().default(DEFAULTS.fallbackEffort),
      'Jev 不可用时（无 Key / 超时 / 限流）的关键词回退默认档。回退表抄自 Claude Code 的 think / think harder / ultrathink。',
    ),
    hysteresisRounds: tunable(
      z.number().step(1).min(0).default(DEFAULTS.hysteresisRounds),
      '迟滞窗口：距离上次换档不足这么多轮就不允许再换，避免在档位间高频横跳。',
    ),
    downgradeStreak: tunable(
      z.number().step(1).min(1).default(DEFAULTS.downgradeStreak),
      '降档需要连续判定为低档的轮数。防止一次误判把推理强度砍掉。',
    ),
    timeoutMs: tunable(
      z.number().step(1).min(200).default(DEFAULTS.timeoutMs),
      '单次 Jev 判定超时（毫秒）。超时即回退，绝不阻塞用户请求。',
    ),
    blockOnDecision: tunable(
      z.boolean().default(DEFAULTS.blockOnDecision),
      '首步请求前等待判定结果。关闭后本轮先用上一轮判定，判定落地后从下一步生效（延迟更低）。',
    ),

    // ── Tier B：自动模型路由（默认关闭） ────────────────────
    modelRouting: tunable(z.boolean().default(DEFAULTS.modelRouting), `自动模型路由（默认关闭）。${CACHE_RISK_NOTICE}`),
    acknowledgeCacheRisk: tunable(
      z.boolean().default(DEFAULTS.acknowledgeCacheRisk),
      '硬门禁：必须勾选此项，modelRouting 才会真正生效。未勾选时插件只记录「本可切换但被拒绝」，绝不改模型。',
    ),
    modelSwitchMode: tunable(
      z.string().default(DEFAULTS.modelSwitchMode),
      '切换时机。turn-boundary = 仅允许在回合起点切换（推荐，本插件只支持这一种）。',
    ),
    modelAllowlist: tunable(
      z.array(z.string()).default(DEFAULTS.modelAllowlist),
      '允许自动切换到的模型白名单。留空表示不参与路由（不会问 Jev 选模型）。建议只填同 provider 内的模型。',
    ),
    modelNotes: tunable(
      z.array(z.string()).default(DEFAULTS.modelNotes),
      '每个候选模型的一句话说明，格式 "模型id: 说明"。用于给 Jev 提供 criteria 描述（选项描述必须可区分）。',
    ),
    customPricing: tunable(
      z.array(z.string()).default(DEFAULTS.customPricing),
      '自备价目，用于非 DeepSeek 模型（官网只提供 DeepSeek 价）。格式 "provider::model=命中,未命中,输出"（USD/1M tokens），' +
        '也可写 "::model=..." 表示不限 provider。没有价目的模型会被成本闸以 no-pricing 拒绝，这是安全的默认值。',
    ),
    stickyRounds: tunable(
      z.number().step(1).min(1).default(DEFAULTS.stickyRounds),
      '候选模型需要连续胜出这么多轮才允许切换。',
    ),
    switchCooldown: tunable(
      z.number().step(1).min(0).default(DEFAULTS.hysteresisRounds),
      '两次模型切换之间的最小间隔轮数。',
    ),
    maxSwitchesPerSession: tunable(
      z.number().step(1).min(0).default(DEFAULTS.hysteresisRounds),
      '单次会话内允许的模型切换次数上限。',
    ),
    hitRateAlert: tunable(
      z.number().min(0).max(1).default(DEFAULTS.hitRateAlert),
      '缓存命中率告警阈值。窗口命中率低于此值会在日志提示并建议 /jev rollback。',
    ),

    // ── Tier C：技能路由（预留） ───────────────────────────
    skillRouting: tunable(
      z.boolean().default(DEFAULTS.skillRouting),
      '（预留）由 Jev 判定应当使用的 skill。首版不实现，开关仅作规划占位。',
    ),

    // ── 价格与计量 ──────────────────────────────────────────
    pricingAutoRefreshHours: z
      .number()
      .step(1)
      .min(0)
      .default(DEFAULTS.pricingAutoRefreshHours)
      .description(
        '价目自动刷新间隔（小时）。0 表示只在启动与手动触发时获取。价格来源：DeepSeek 官网 api-docs.deepseek.com/quick_start/pricing。改动需重启。',
      ),
    pricingCachePath: z
      .string()
      .default(DEFAULTS.pricingCachePath)
      .description('价目缓存文件路径。留空则使用 ~/.dsh/jev-router/pricing.json。改动需重启。'),
    holidays: tunable(
      z.array(z.string()).default(DEFAULTS.holidays),
      '中国法定节假日（YYYY-MM-DD 列表），用于 peak/off-peak 判定。留空时无法识别的日子按 peak 计（偏保守）。',
    ),

    // ── 界面 ────────────────────────────────────────────────
    showBadge: tunable(z.boolean().default(DEFAULTS.showBadge), '在输入框工具行显示当前思考强度徽章。'),
    apiKeyRef: tunable(
      z.string().default(DEFAULTS.apiKeyRef),
      '存放 TypeSafe API Key 的凭据名。密钥本体通过本页的输入框写入 DSH 凭据存储，不会写进 profile 配置文件。',
    ),
    namespace: z
      .string()
      .default(DEFAULTS.namespace)
      .description('设置 namespace（= cordis.patch.yml 里的 loader entry id）。除非改过挂载 id，否则不要动。改动需重启。'),
  });
}

export const Config = buildConfig();

/** 取默认价目缓存路径。 */
export function defaultPricingPath(homedirPath, namespace = DEFAULT_NAMESPACE) {
  return `${homedirPath}/.dsh/${namespace}/pricing.json`;
}

/**
 * 声明本插件的设置页策略。
 *
 * 配置字段本身就是设置页的来源，所以这里只需要标记「本实例用自动生成的页面」。
 * 老 host 没有 settings 服务时静默跳过——插件其余功能不受影响。
 *
 * @returns {{installed: boolean, reason?: string}}
 */
export function installSettings(ctx) {
  try {
    const settings = ctx.get('settings');
    if (typeof settings?.configure !== 'function') {
      return { installed: false, reason: 'no-settings-service' };
    }
    ctx.effect(() => settings.configure({ auto: true }), 'dsh-jev-router: settings page policy');
    return { installed: true };
  } catch (error) {
    return { installed: false, reason: String(error?.message ?? error) };
  }
}
