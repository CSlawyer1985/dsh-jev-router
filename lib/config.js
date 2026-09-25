/**
 * 配置解析层。
 *
 * 为什么必须有这一层：DSH 的 `.volatile()` 字段（运行时可通过设置页修改的字段）
 * 在插件里拿到的**不是裸值**，而是一个不可变引用对象：
 *
 *   function createVolatile(value) {
 *     let current = snapshot(value)
 *     return Object.freeze({ get: () => current, [write]: (v) => { current = v } })
 *   }
 *   function isVolatile(value) { return typeof value === 'object' && value !== null && write in value }
 *
 * 于是 `live.modelRouting === true` 恒为 false、`live.confidenceFloor` 参与比较会得到
 * NaN、`live.timeoutMs` 传进 setTimeout 会变成 NaN —— 也就是说：
 * **不解析 volatile 引用，整个策略层在实机上是静默失效的。**
 *
 * 这是实机启动后才暴露出来的问题（单测里传的是裸对象，所以一路全绿）。
 *
 * 说明：`isVolatile` 的官方判定依赖 cosmokit 内部的 write 符号，本插件不便引入该依赖。
 * 但本插件的配置字段只有布尔 / 数字 / 字符串 / 字符串数组，都不带 get 方法，
 * 因此「有 get 方法」在这个字段集合上是安全的等价判定。
 */

/** 每个配置字段的唯一默认值真源。settings.js 的 schema 也从这里取默认值，避免两处漂移。 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  effort: 'auto',
  confidenceFloor: 0.5,
  fallbackEffort: 'high',
  hysteresisRounds: 2,
  /**
   * 降档需要连续确认的轮数。
   *
   * 注意这只作用于「**高**错误代价」的降档：低代价（risk <= riskCeiling）
   * 或用户明说（关键词回退）的降档立即生效，见 policy.js 的 needsConfirmation。
   */
  downgradeStreak: 2,
  /**
   * 「低错误代价」的判定上界（Jev 的 risk 分数，0-3）。
   *
   * 实测正常问题的 risk 落在 0.3-0.4 区间，因此 0.6 能覆盖绝大多数
   * 低风险请求的降档，同时把 AI 自己判断"答错后果严重"的情形留给连续确认。
   */
  riskCeiling: 0.6,
  /**
   * 是否把生效档位**同步进会话配置**（写一条 model/selection）。
   *
   * 为什么默认开：Tier A 只改单次调用的 reasoningEffort，DSH 自己的
   * 「模型后面的思考程度」读的是**会话配置**，不同步的话原生界面永远不动，
   * 用户看不到插件在工作。
   *
   * 代价：每次档位变化会往会话日志追加一条持久事件，并且会覆盖你在
   * DSH 原生档位选择器里的手动选择（想固定档位请用本插件的「手动钉死档位」）。
   * 缓存安全不受影响 —— effort 不参与 messages 的构造。
   */
  syncSessionEffort: true,
  /**
   * `off` 地板的字符阈值：消息不短于此长度时，不允许降到 `off`。
   *
   * 理由：`off` 的语义是"琐碎到不需要思考"，它需要正面证据——一条短消息。
   * 而 Jev 的 CJK 准确率官方明确说明较低（英语优先），
   * "长中文请求被判成 off"是已知高风险组合。抬到 low 代价极小、方向安全。
   * 设为 0 关闭这道地板。
   */
  offFloorChars: 280,
  /**
   * 单次判定的超时。
   *
   * ⚠️ 不要按"热调用中位数"来设。实测（同一 Key、连续调用）：
   *   冷启动 1367-1463ms（DNS + TLS + 握手）
   *   热调用  358-548ms
   * 早先默认 1500ms 恰好卡在两者之间，导致**重启后第一次判定几乎必然超时**，
   * 静默降级成关键词回退——用户看到的是"这个能力没生效"。
   * 4000ms 给冷启动留出足够余量，同时仍远低于用户能感知的卡顿阈值；
   * 判定本身在后台进行（blockOnDecision），不会拖慢首字。
   */
  timeoutMs: 4000,
  blockOnDecision: true,
  modelRouting: false,
  acknowledgeCacheRisk: false,
  modelSwitchMode: 'turn-boundary',
  modelAllowlist: Object.freeze([]),
  modelNotes: Object.freeze([]),
  customPricing: Object.freeze([]),
  stickyRounds: 3,
  switchCooldown: 2,
  maxSwitchesPerSession: 2,
  hitRateAlert: 0.8,
  skillRouting: false,
  pricingAutoRefreshHours: 24,
  pricingCachePath: '',
  holidays: Object.freeze([]),
  showBadge: true,
  namespace: 'jev-router',
  /** 存放 TypeSafe API Key 的凭据名（CredentialRef）。密钥本身进凭据存储，不写进 profile 配置。 */
  apiKeyRef: 'TYPESAFE_API_KEY',
});

/** 运行时不可改的结构性字段（schema 里不加 .volatile()）。 */
export const STRUCTURAL_KEYS = Object.freeze([
  'pricingAutoRefreshHours',
  'pricingCachePath',
  'namespace',
]);

/** 判定一个值是不是 volatile 引用。 */
export function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && typeof value.get === 'function';
}

/**
 * 读单个配置值，自动拆掉 volatile 引用。
 *
 * @param {object|undefined} config loader 传入的配置对象
 * @param {string} key
 * @param {unknown} [fallback] 缺省值
 */
export function readConfig(config, key, fallback = DEFAULTS[key]) {
  if (!config || typeof config !== 'object') return fallback;
  const raw = config[key];
  if (raw === undefined || raw === null) return fallback;
  if (isVolatileRef(raw)) {
    try {
      const value = raw.get();
      return value === undefined ? fallback : value;
    } catch {
      // 引用被释放或内部状态异常时不要抛出：退回默认值比打断用户请求好。
      return fallback;
    }
  }
  return raw;
}

/**
 * 把整份配置解析成**裸值对象**。
 *
 * 策略层（policy.js）接收的就是这个对象，因此它读到的永远是真正的布尔与数字。
 *
 * @param {object|undefined} config
 * @returns {Record<string, unknown>}
 */
export function resolveConfig(config) {
  const resolved = {};
  for (const key of Object.keys(DEFAULTS)) {
    resolved[key] = readConfig(config, key, DEFAULTS[key]);
  }
  return resolved;
}
