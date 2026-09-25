/**
 * dsh-jev-router — 静态 Client 模块。
 *
 * DSH 静态 client 模块格式（window.__ModuleLoader__.load）：
 *   - host 侧扫描声明了 dsh.client 的包，把本文件挂到 /plugins/dsh-jev-router/client.js
 *   - 浏览器加载并注册 factory；React 由 seed 提供
 *
 * 与本插件 Host 半的通信走同源 HTTP 路由（/jev-router/*），
 * 因为 host.call 只属于动态插件 runner，静态模块没有该能力。
 *
 * 作者：chenshi.ai · https://chenshi.ai
 */

window.__ModuleLoader__.load({
  id: "dsh-jev-router",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const NS = "dsh-jev-router";
    const STATUS_URL = "/jev-router/status";
    const CONFIG_URL = "/jev-router/config";
    const CREDENTIAL_URL = "/jev-router/credential";
    const TEST_URL = "/jev-router/test";
    const REFRESH_URL = "/jev-router/pricing/refresh";
    const CYCLE = ["auto", "off", "low", "high", "max"];

    const inject = ["slots"];

    // ── Host 半的数据访问 ─────────────────────────────────────
    /**
     * 取状态。
     *
     * @param {string|null} sessionId 会话作用域的调用方必须传自己的 sessionId：
     *   不传时服务端只能回落到"最近活跃会话"，在多会话下会拿到**别的会话**的
     *   档位——用户就会看到"A 会话显示成 B 会话的档位"。
     */
    async function fetchStatus(sessionId) {
      try {
        const response = await fetch(STATUS_URL, { cache: "no-store" });
        if (!response.ok) return null;
        return await response.json();
      } catch {
        return null;
      }
    }

    async function postConfig(patch) {
      try {
        const response = await fetch(CONFIG_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ patch }),
        });
        return await response.json();
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) };
      }
    }

    async function postCredential(body) {
      try {
        const response = await fetch(CREDENTIAL_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return await response.json();
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) };
      }
    }

    async function postTest() {
      try {
        const response = await fetch(TEST_URL, { method: "POST" });
        return await response.json();
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) };
      }
    }

    async function postRefresh() {
      try {
        const response = await fetch(REFRESH_URL, { method: "POST" });
        return await response.json();
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) };
      }
    }

    /** 轮询状态；返回 [status, reload]。 */
    function useStatus(intervalMs, sessionId) {
      const [status, setStatus] = React.useState(null);
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        let alive = true;
        const load = async () => {
          const next = await fetchStatus(sessionId);
          if (alive && next) setStatus(next);
        };
        load();
        const timer = setInterval(load, intervalMs);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [intervalMs, tick, sessionId]);
      return [status, () => setTick((value) => value + 1)];
    }

    // ── 样式（内联，避免依赖 ui-primitives 的类名契约） ────────
    const S = {
      card: {
        border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
        borderRadius: 10,
        padding: "14px 16px",
        marginBottom: 12,
      },
      h: { fontSize: 14, fontWeight: 600, margin: "0 0 10px" },
      row: { display: "flex", alignItems: "center", gap: 10, margin: "6px 0" },
      label: { fontSize: 13, flex: "1 1 auto" },
      hint: { fontSize: 11, opacity: 0.65, lineHeight: 1.5, marginTop: 4 },
      grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10 },
      num: {
        width: 74,
        fontSize: 12,
        padding: "4px 7px",
        borderRadius: 6,
        border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
        background: "transparent",
        color: "inherit",
        textAlign: "right",
        flex: "0 0 auto",
      },
      select: {
        fontSize: 12,
        padding: "4px 6px",
        borderRadius: 6,
        border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
        background: "transparent",
        color: "inherit",
        flex: "0 0 auto",
      },
      sub: { fontSize: 12, fontWeight: 600, opacity: 0.8, margin: "12px 0 4px" },
      metric: { padding: "8px 10px", borderRadius: 8, background: "color-mix(in srgb, currentColor 7%, transparent)" },
      metricLabel: { fontSize: 11, opacity: 0.7 },
      metricValue: { fontSize: 16, fontWeight: 600, marginTop: 2 },
      toggle: { width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer", flex: "0 0 auto" },
      button: {
        fontSize: 12,
        padding: "5px 10px",
        borderRadius: 6,
        cursor: "pointer",
        border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
        background: "transparent",
        color: "inherit",
      },
      badge: {
        fontSize: 11,
        padding: "2px 7px",
        borderRadius: 999,
        border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        lineHeight: 1.6,
      },
      warn: {
        fontSize: 12,
        lineHeight: 1.6,
        padding: "10px 12px",
        borderRadius: 8,
        background: "color-mix(in srgb, #e0a020 16%, transparent)",
        border: "1px solid color-mix(in srgb, #e0a020 45%, transparent)",
        margin: "8px 0",
      },
      author: { fontSize: 11, opacity: 0.7, marginTop: 10, lineHeight: 1.6 },
    };

    /**
     * 数字输入。失焦或回车才提交——避免每敲一个字符就写一次设置。
     * 本地值允许在编辑期间存在（比如把 "2" 清空准备输 "10"）。
     */
    function NumberField({ value, min, max, step, onCommit, disabled }) {
      const [draft, setDraft] = React.useState(String(value));
      React.useEffect(() => setDraft(String(value)), [value]);
      const commit = () => {
        const n = Number(draft);
        if (!Number.isFinite(n)) {
          setDraft(String(value));
          return;
        }
        const clamped = Math.min(max === undefined ? Infinity : max, Math.max(min === undefined ? -Infinity : min, n));
        setDraft(String(clamped));
        if (clamped !== value) onCommit(clamped);
      };
      return h("input", {
        type: "number",
        value: draft,
        min,
        max,
        step: step === undefined ? 1 : step,
        disabled,
        style: S.num,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === "Enter") commit();
        },
      });
    }

    /** 数字行：标签 + 说明 + 输入框 */
    function NumberRow({ label, hint, value, min, max, step, onCommit, disabled }) {
      return h(
        "div",
        null,
        h(
          "div",
          { style: S.row },
          h("span", { style: S.label }, label),
          h(NumberField, { value, min, max, step, onCommit, disabled }),
        ),
        hint ? h("div", { style: S.hint }, hint) : null,
      );
    }

    function Toggle({ on, onChange, disabled }) {
      return h("button", {
        type: "button",
        "aria-pressed": on ? "true" : "false",
        disabled: Boolean(disabled),
        onClick: () => onChange(!on),
        style: Object.assign({}, S.toggle, {
          background: on ? "#2f9e44" : "color-mix(in srgb, currentColor 25%, transparent)",
          opacity: disabled ? 0.5 : 1,
        }),
      });
    }

    function fmtPct(value) {
      if (value === null || value === undefined) return "—";
      return (value * 100).toFixed(2) + "%";
    }

    function fmtNum(value) {
      if (value === null || value === undefined) return "—";
      return Number(value).toLocaleString();
    }

    function fmtUsd(value) {
      if (value === null || value === undefined) return "—";
      return "$" + Number(value).toFixed(4);
    }

    // ── 输入框徽章 ───────────────────────────────────────────
    function JevBadge(props) {
      // 槽位契约的 standardProps 里有 sessionId，本槽位是 session 作用域，
      // 因此徽章能精确知道自己属于哪个会话。
      const sessionId = props && props.sessionId ? String(props.sessionId) : null;
      const [status, reload] = useStatus(4000, sessionId);
      // 只有 scope === 'exact' 才是**本会话**的数据。拿不到会话 id 时服务端只能给
      // "最近活跃会话"，那可能是别的会话——宁可不显示，也不能显示错的档位。
      const exact = Boolean(status && status.session && status.session.scope === "exact");
      if (status && !exact) {
        // ⚠️ 这里**绝不能**写配置。
        // 早先这个占位按钮的 onClick 会 postConfig({effort: 下一档})，
        // 点一下就把**全局**手动档位从 auto 改成 off，于是所有会话都被钉死、
        // Jev 判定被完全绕过——用户看到的现象是「思考强度完全不变化」。
        // 一个"状态未知"的占位符不该有任何副作用。
        return h(
          "button",
          {
            type: "button",
            disabled: true,
            style: Object.assign({}, S.badge, { opacity: 0.5, cursor: "default" }),
            title: "Jev 路由：尚未确定当前会话的档位（等待会话就绪）。此按钮只做提示，不改变任何设置。",
          },
          "⚡ ?",
        );
      }
      const effort = status && status.session ? status.session.effort || status.session.decided : null;
      const decided = status && status.session ? status.session.decided : null;
      const enabled = status && status.config ? status.config.enabled : true;
      const current = status && status.config ? status.config.effort : "auto";
      // 手动钉死时，Jev 判定被完全绕过 —— 必须在徽章上标出来，
      // 否则用户会以为「自动调节不工作」。
      const manual = Boolean(current && current !== "auto");
      const verdict = status && status.session ? status.session.lastEffortVerdict : null;
      const isManual = manual || (verdict && verdict.reason === "manual-override");
      const title = status
        ? [
            "Jev 路由：" + (enabled ? "开" : "关"),
            manual
              ? "手动档位：" + current + "（Jev 自动判定已被绕过；点一下回到 auto）"
              : "手动档位：auto（Jev 自动判定生效中）",
            "Jev 判定：" + (decided || "—"),
            "生效档位：" + (effort || "harness 默认"),
            "缓存命中率：" + fmtPct(status.metrics ? status.metrics.hitRate : null),
            "点击切换档位（auto → off → low → high → max）",
          ].join("\n")
        : "Jev 路由：读取中…";

      return h(
        "button",
        {
          type: "button",
          title,
          style: Object.assign({}, S.badge, { opacity: enabled ? 1 : 0.5 }),
          // 点击循环：auto → off → low → high → max → auto。
          // 当前是手动档位时，第一次点击直接回到 auto（而不是继续往下降一档），
          // 这样"解锁"只需一次点击，也减少误把自动模式往下调的机会。
          onClick: async () => {
            const next = isManual ? "auto" : CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length];
            await postConfig({ effort: next });
            reload();
          },
        },
        // 手动钉死时用 🔒 明确区分，避免"自动调节好像没用"的误解。
        (isManual ? "🔒 " : "⚡ ") + (effort || "auto"),
      );
    }

    // ── 设置页 ───────────────────────────────────────────────
    function JevSection() {
      const [status, reload] = useStatus(5000);
      const [apiKey, setApiKey] = React.useState("");
      const [step, setStep] = React.useState(0);
      const [ack, setAck] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState("");
      const [refreshing, setRefreshing] = React.useState(false);
      // 只暴露"有没有配"，不暴露任何 Key 内容。
      const credentialConfigured = Boolean(status && status.credential && status.credential.configured);
      // 设置页是 root 作用域，拿不到 sessionId，服务端只能给"最近活跃会话"。
      // 必须把它标出来，否则用户会以为这是"当前会话"的数字。
      const sessionScope = status && status.session ? status.session.scope : null;
      const sessionKey = status && status.session ? status.session.sessionKey : null;
      const scopedLabel =
        sessionScope === 'most-recent'
          ? "最近活跃会话" + (sessionKey ? "（…" + sessionKey + "）" : "") + " · 非本页所属会话"
          : sessionScope === 'exact'
            ? "本会话"
            : "无活跃会话";

      const config = (status && status.config) || {};
      const metrics = (status && status.metrics) || {};
      const session = (status && status.session) || {};
      const pricing = (status && status.pricing) || {};

      const apply = async (patch) => {
        setBusy(true);
        const result = await postConfig(patch);
        setBusy(false);
        setMessage(result && result.ok ? "已保存。" : "保存失败：" + ((result && (result.reason || result.error)) || "未知错误"));
        reload();
      };

      const enableModelRouting = async () => {
        setBusy(true);
        const result = await postConfig({ modelRouting: true, acknowledgeCacheRisk: true });
        setBusy(false);
        if (result && result.ok) {
          setMessage("自动模型路由已开启（仅回合起点切换）。可用 /jev rollback 回滚。");
          setStep(0);
          setAck(false);
        } else {
          setMessage("开启失败：" + ((result && (result.reason || result.error)) || "未知错误"));
        }
        reload();
      };

      const switchCost = pricing.switchCostUsd;
      const breakeven = pricing.breakevenOutputTokens;

      return h(
        "div",
        null,

        // Jev API Key —— 一行三按钮：一个输入框 + 保存 / 连通 / 清除。
        // 密钥只以密文形式存在，永不回显：写入后输入框立即清空，
        // 状态只显示「已配置 / 未配置」，不含任何 Key 字符。
        h(
          "div",
          { style: S.card },
          h("div", { style: S.h }, "Jev API Key（TypeSafe）"),
          h(
            "div",
            { style: S.row },
            h("input", {
              type: "password",
              value: apiKey,
              placeholder: credentialConfigured ? "已配置（输入新 Key 可覆盖）" : "粘贴 TypeSafe API Key",
              autoComplete: "off",
              autoCorrect: "off",
              spellCheck: false,
              onChange: (event) => setApiKey(event.target.value),
              style: {
                flex: "1 1 auto",
                minWidth: 0,
                fontSize: 12,
                padding: "5px 8px",
                borderRadius: 6,
                border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
                background: "transparent",
                color: "inherit",
              },
            }),
            h(
              "button",
              {
                type: "button",
                style: S.button,
                disabled: busy || !apiKey.trim(),
                onClick: async () => {
                  setBusy(true);
                  const result = await postCredential({ value: apiKey });
                  setBusy(false);
                  // 无论成功与否都清空输入框：密钥不在界面上停留。
                  setApiKey("");
                  setMessage(
                    result && result.ok
                      ? "已保存，立即生效。"
                      : "保存失败：" + ((result && (result.reason || result.error)) || "未知错误"),
                  );
                  reload();
                },
              },
              "保存",
            ),
            h(
              "button",
              {
                type: "button",
                style: S.button,
                disabled: busy,
                onClick: async () => {
                  setBusy(true);
                  const result = await postTest();
                  setBusy(false);
                  if (result && result.ok) {
                    setMessage(
                      "已接通 · " +
                        result.jevModel +
                        " · " +
                        result.effort +
                        "（置信度 " +
                        (result.confidence === null || result.confidence === undefined
                          ? "—"
                          : Number(result.confidence).toFixed(2)) +
                        "） · " +
                        result.elapsedMs +
                        "ms",
                    );
                  } else {
                    setMessage("未接通：" + ((result && (result.reason || result.error)) || "未知错误"));
                  }
                },
              },
              "连通",
            ),
            h(
              "button",
              {
                type: "button",
                style: S.button,
                disabled: busy,
                onClick: async () => {
                  setBusy(true);
                  const result = await postCredential({ clear: true });
                  setBusy(false);
                  setApiKey("");
                  setMessage(result && result.ok ? "已清除。" : "清除失败：" + ((result && (result.reason || result.error)) || "未知错误"));
                  reload();
                },
              },
              "清除",
            ),
          ),
          h(
            "div",
            { style: S.hint },
            (credentialConfigured ? "状态：已配置" : "状态：未配置（当前走关键词回退）") +
              "。密钥写入 DSH 凭据存储，不会出现在配置文件里，也不会回显。",
          ),
        ),

        // 实时度量
        h(
          "div",
          { style: S.card },
          h("div", { style: S.h }, "缓存与成本（实时）"),
          h(
            "div",
            { style: S.grid },
            h("div", { style: S.metric }, h("div", { style: S.metricLabel }, "命中率（累计）"), h("div", { style: S.metricValue }, fmtPct(metrics.hitRate))),
            h("div", { style: S.metric }, h("div", { style: S.metricLabel }, "命中率（近 50 步）"), h("div", { style: S.metricValue }, fmtPct(metrics.windowHitRate))),
            h("div", { style: S.metric }, h("div", { style: S.metricLabel }, "缓存命中 tokens"), h("div", { style: S.metricValue }, fmtNum(metrics.cacheReadTokens))),
            h("div", { style: S.metric }, h("div", { style: S.metricLabel }, "未命中 tokens"), h("div", { style: S.metricValue }, fmtNum(metrics.inputTokens))),
            h("div", { style: S.metric }, h("div", { style: S.metricLabel }, "缓存省下"), h("div", { style: S.metricValue }, fmtUsd(metrics.cacheSavingUsd))),
            h(
              "div",
              { style: S.metric },
              h("div", { style: S.metricLabel }, "reasoning 占输出"),
              h(
                "div",
                { style: S.metricValue },
                metrics.reasoningReported ? fmtPct(metrics.reasoningShare) : "未上报",
              ),
            ),
          ),
          h(
            "div",
            { style: S.hint },
            "命中率 = 缓存命中 tokens ÷（命中 + 未命中）。DSH 把未命中的部分记为 inputTokens，命中的记为 cacheReadTokens。" +
              "reasoning 占比显示「未上报」时，表示当前 provider 没有在 usage 里返回 reasoningTokens——" +
              "这是 provider 侧的行为，不是 0 次思考。",
          ),
        ),

        // Tier A
        h(
          "div",
          { style: S.card },
          h("div", { style: S.h }, "思考强度路由（默认开启 · 缓存安全）"),
          h(
            "div",
            { style: S.row },
            h("span", { style: S.label }, "启用总开关"),
            h(Toggle, {
              on: config.enabled !== false,
              disabled: busy,
              onChange: (value) => apply({ enabled: value }),
            }),
          ),
          h(
            "div",
            { style: S.row },
            h("span", { style: S.label }, "生效档位"),
            h("span", { style: { fontSize: 13, fontWeight: 600 } }, session.effort || "harness 默认"),
            h("span", { style: { fontSize: 12, opacity: 0.7 } }, "Jev 判定：" + (session.decided || "—") + (session.confidence !== null && session.confidence !== undefined ? "（置信度 " + session.confidence + "）" : "")),
          ),
          // 多会话下，设置页拿不到自己所属的会话，必须说清楚这些数字是谁的。
          h("div", { style: S.hint }, "以上为「" + scopedLabel + "」的数据；输入框徽章显示的才是你当前会话的档位。"),
          h(
            "div",
            { style: S.row },
            h("span", { style: S.label }, "手动钉死档位"),
            ...CYCLE.map((value) =>
              h(
                "button",
                {
                  key: value,
                  type: "button",
                  disabled: busy,
                  style: Object.assign({}, S.button, {
                    background: config.effort === value ? "color-mix(in srgb, currentColor 18%, transparent)" : "transparent",
                    fontWeight: config.effort === value ? 600 : 400,
                  }),
                  onClick: () => apply({ effort: value }),
                },
                value,
              ),
            ),
          ),
          h(
            "div",
            { style: S.hint },
            "只改 reasoningEffort，不碰模型、不碰 prompt 前缀，因此不破坏前缀缓存。手动值永远压过自动判定。",
          ),

          // ── 调参（全部可调项都在这里，不必去 DSH 通用设置里找）──
          h("div", { style: S.sub }, "判定与时机"),
          h(NumberRow, {
            label: "置信度门",
            hint: "Jev 置信度低于此值就弃权，沿用当前档位。实测「一个星期几天」为 0.40、「你好」为 1.00。",
            value: config.confidenceFloor,
            min: 0,
            max: 1,
            step: 0.05,
            onCommit: (v) => apply({ confidenceFloor: v }),
            disabled: busy,
          }),
          h(NumberRow, {
            label: "低代价降档上界（riskCeiling）",
            hint: "Jev 的出错代价（0-3）不超过此值时，降档立即生效、不等确认；超过则仍要连续确认。实测「你好」0.00、「JSON 格式化」0.30、「重构架构」2.24。",
            value: config.riskCeiling,
            min: 0,
            max: 3,
            step: 0.1,
            onCommit: (v) => apply({ riskCeiling: v }),
            disabled: busy,
          }),
          h(NumberRow, {
            label: "降档连续确认轮数",
            hint: "只作用于「高错误代价」的降档。设为 1 表示一律立即降档。",
            value: config.downgradeStreak,
            min: 1,
            max: 10,
            onCommit: (v) => apply({ downgradeStreak: v }),
            disabled: busy,
          }),
          h(NumberRow, {
            label: "迟滞窗口（轮）",
            hint: "距上次换档不足这么多轮就不动，防止档位高频横跳。",
            value: config.hysteresisRounds,
            min: 0,
            max: 20,
            onCommit: (v) => apply({ hysteresisRounds: v }),
            disabled: busy,
          }),
          h(NumberRow, {
            label: "判定超时（毫秒）",
            hint: "超时就放弃本轮判定，绝不阻塞你的请求。实测中位耗时约 430ms。",
            value: config.timeoutMs,
            min: 200,
            max: 20000,
            step: 100,
            onCommit: (v) => apply({ timeoutMs: v }),
            disabled: busy,
          }),
          h(
            "div",
            { style: S.row },
            h("span", { style: S.label }, "关键词回退默认档位"),
            h(
              "select",
              {
                style: S.select,
                value: config.fallbackEffort,
                disabled: busy,
                onChange: (event) => apply({ fallbackEffort: event.target.value }),
              },
              ["off", "low", "high", "max"].map((v) => h("option", { key: v, value: v }, v)),
            ),
          ),
          h(
            "div",
            { style: S.row },
            h("span", { style: S.label }, "首步等待判定（关掉可降低首字延迟）"),
            h(Toggle, {
              on: config.blockOnDecision !== false,
              disabled: busy,
              onChange: (value) => apply({ blockOnDecision: value }),
            }),
          ),
          h(
            "div",
            { style: S.row },
            h("span", { style: S.label }, "输入框档位徽章"),
            h(Toggle, {
              on: config.showBadge !== false,
              disabled: busy,
              onChange: (value) => apply({ showBadge: value }),
            }),
          ),

          h("div", { style: S.sub }, "模型路由参数"),
          h(NumberRow, {
            label: "候选连续胜出轮数（stickyRounds）",
            hint: "防止模型在候选间来回切换。",
            value: config.stickyRounds,
            min: 1,
            max: 10,
            onCommit: (v) => apply({ stickyRounds: v }),
            disabled: busy,
          }),
          h(NumberRow, {
            label: "切换冷却（轮）",
            hint: "两次模型切换之间的最小间隔。",
            value: config.switchCooldown,
            min: 0,
            max: 20,
            onCommit: (v) => apply({ switchCooldown: v }),
            disabled: busy,
          }),
          h(NumberRow, {
            label: "单会话切换上限",
            hint: "超过后本会话不再自动切模型。",
            value: config.maxSwitchesPerSession,
            min: 0,
            max: 20,
            onCommit: (v) => apply({ maxSwitchesPerSession: v }),
            disabled: busy,
          }),
          h(NumberRow, {
            label: "命中率告警阈值",
            hint: "窗口命中率跌破此值时提示你考虑 /jev rollback。",
            value: config.hitRateAlert,
            min: 0,
            max: 1,
            step: 0.05,
            onCommit: (v) => apply({ hitRateAlert: v }),
            disabled: busy,
          }),
        ),

        // Tier B
        h(
          "div",
          { style: S.card },
          h("div", { style: S.h }, "自动模型路由（默认关闭 · 会破坏缓存）"),
          h(
            "div",
            { style: S.row },
            h("span", { style: S.label }, "启用自动模型路由"),
            h(Toggle, {
              on: config.modelRouting === true,
              disabled: busy,
              onChange: (value) => {
                if (!value) {
                  apply({ modelRouting: false });
                  setStep(0);
                  return;
                }
                setStep(1);
              },
            }),
          ),

          step === 1 &&
            h(
              "div",
              { style: S.warn },
              h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "第 1 步 / 共 3 步：这会做什么"),
              h(
                "div",
                null,
                "自动模型路由会在会话中途更换模型。跨模型没有缓存复用——DSH 在回放历史时会丢弃 thinking 块的 signature（跨模型 signature 不可移植），这会重写已缓存的会话前缀。",
              ),
              h(
                "div",
                { style: { marginTop: 8 } },
                h("button", { type: "button", style: S.button, onClick: () => setStep(2) }, "我已了解，继续"),
                " ",
                h("button", { type: "button", style: S.button, onClick: () => setStep(0) }, "取消"),
              ),
            ),

          step === 2 &&
            h(
              "div",
              { style: S.warn },
              h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "第 2 步 / 共 3 步：用你自己的数据算一遍"),
              h(
                "div",
                null,
                "当前累计命中率 " + fmtPct(metrics.hitRate) + "；累计命中 " + fmtNum(metrics.cacheReadTokens) + " / 未命中 " + fmtNum(metrics.inputTokens) + " tokens。",
              ),
              h(
                "div",
                { style: { marginTop: 6 } },
                "切换一次模型的额外缓存成本 ≈ " + fmtUsd(switchCost) + "；回本条件是省下超过 " + (breakeven === null || breakeven === undefined ? "（需要先有一次请求样本）" : Math.round(breakeven).toLocaleString() + " 个输出 token") + "。",
              ),
              h(
                "div",
                { style: { marginTop: 6 } },
                "规则：Δ_out > 0.32 × 前缀长度。典型思考预算 1–8K token —— 大概率不回本，插件会在每轮真实比较后自行拒绝切换。",
              ),
              h(
                "label",
                { style: { display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10, cursor: "pointer" } },
                h("input", { type: "checkbox", checked: ack, onChange: (event) => setAck(event.target.checked) }),
                h("span", null, "我已理解，并接受缓存命中率下降（可用 /jev rollback 回滚）。"),
              ),
              h(
                "div",
                { style: { marginTop: 8 } },
                h("button", { type: "button", style: S.button, disabled: !ack || busy, onClick: () => setStep(3) }, "继续"),
                " ",
                h("button", { type: "button", style: S.button, onClick: () => { setStep(0); setAck(false); } }, "取消"),
              ),
            ),

          step === 3 &&
            h(
              "div",
              { style: S.warn },
              h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "第 3 步 / 共 3 步：选择模式"),
              h("div", null, "本插件只支持「仅任务边界切换」：模型只允许在回合起点更换，绝不在回合中途换。"),
              h(
                "div",
                { style: { marginTop: 8 } },
                h("button", { type: "button", style: S.button, disabled: busy, onClick: enableModelRouting }, "确认开启"),
                " ",
                h("button", { type: "button", style: S.button, onClick: () => { setStep(0); setAck(false); } }, "取消"),
              ),
            ),

          h(
            "div",
            { style: S.hint },
            "缓存风险已确认：" + (config.acknowledgeCacheRisk ? "是" : "否") + "。未确认为「是」时，即使开关打开，策略层也会拒绝一切模型切换（硬门禁，在代码里而不是在文档里）。",
          ),
          session.previousModel
            ? h(
                "div",
                { style: S.row },
                h("span", { style: S.label }, "可回滚到 " + session.previousModel),
                h("button", { type: "button", style: S.button, onClick: () => apply({}) }, "在对话里发送 /jev rollback"),
              )
            : null,
          session.lastModelVerdict
            ? h("div", { style: S.hint }, "最近一次模型闸门裁决：" + session.lastModelVerdict.reason)
            : null,
        ),

        // 价目
        h(
          "div",
          { style: S.card },
          h("div", { style: S.h }, "价目（来自 DeepSeek 官网）"),
          h(
            "div",
            { style: S.hint },
            "来源 " + (pricing.source || "—") + " · 抓取于 " + (pricing.fetchedAt || "—") + " · 当前时段 " + (pricing.period === "peak" ? "峰值" : pricing.period === "offpeak" ? "非峰值" : "—"),
          ),
          pricing.model
            ? h(
                "div",
                { style: { fontSize: 12, marginTop: 8, lineHeight: 1.7 } },
                pricing.model + "：命中 $" + pricing.hit + " / 未命中 $" + pricing.miss + " / 输出 $" + pricing.out + "（每 M tokens）",
              )
            : null,
          h(
            "div",
            { style: { marginTop: 10 } },
            h(
              "button",
              {
                type: "button",
                style: S.button,
                disabled: refreshing,
                onClick: async () => {
                  setRefreshing(true);
                  const result = await postRefresh();
                  setRefreshing(false);
                  setMessage(result && result.ok ? "价目已从官网刷新。" : "刷新失败：" + ((result && (result.reason || result.error)) || "未知错误"));
                  reload();
                },
              },
              refreshing ? "刷新中…" : "从官网刷新价目",
            ),
          ),
        ),

        message ? h("div", { style: S.hint }, message) : null,

        // 署名
        h(
          "div",
          { style: S.author },
          "dsh-jev-router v0.1.0 · 作者 " + ((status && status.author) || "chenshi.ai") + " · " + ((status && status.authorUrl) || "https://chenshi.ai"),
          h("br"),
          "决策模型：Jev（TypeSafe AI System One）· 设计原则：判定永不进入 prompt 前缀。",
        ),
      );
    }

    /**
     * 挂载一个槽位。
     *
     * 必须走 slots.inject，不能直接 register —— 这是踩过的坑：
     * slot 由**属主插件**通过 children 表声明（如 settings.section 属于
     * dsh-client-ui-settings、conversation.input.left 属于
     * dsh-client-ui-conversation），而本插件的 apply() 与属主插件的声明
     * **顺序没有保证**。slot 尚未声明时 register 会抛：
     *   slot "settings.section" is not declared (a parent entry's children table must declare it)
     * client fiber 一旦变成 FAILED，前端启动检查会判定
     *   "web boot: 1 entry did not activate / dsh-jev-router: failed"
     * 整个应用直接起不来（表现为只能用安全模式启动）。
     *
     * inject 会等到 slot 就绪再执行回调；外面再包一层 try/catch，
     * 保证**任何界面问题都只降级为控制台告警，绝不阻断 DSH 启动**。
     */
    function mountSlot(slots, disposers, slotName, declaration, render) {
      try {
        const dispose = slots.inject(slotName, () =>
          slots.register(Object.assign({ name: slotName }, declaration), render),
        );
        disposers.push(dispose);
        return true;
      } catch (error) {
        console.warn(
          "[" + NS + "] 槽位 " + slotName + " 挂载失败（界面降级，不影响 DSH 启动）：" +
            String(error && error.message ? error.message : error),
        );
        return false;
      }
    }

    function apply(ctx) {
      // apply 本身绝不抛：界面插件的任何失败都不该让 DSH 起不来。
      try {
        const slots =
          ctx.slots ?? (typeof ctx.get === "function" ? ctx.get("slots") : undefined);
        if (!slots || typeof slots.register !== "function" || typeof slots.inject !== "function") {
          console.warn("[" + NS + "] slots 服务不可用，界面未挂载（不影响 DSH 启动）");
          return;
        }

        const disposers = [];

        mountSlot(
          slots,
          disposers,
          "settings.section",
          { id: "jev-router", order: 55, label: () => "Jev 路由" },
          () => h(JevSection, null),
        );

        mountSlot(
          slots,
          disposers,
          "conversation.input.left",
          { id: "jev-router-badge", order: 60, label: () => "Jev 档位" },
          () => h(JevBadge, null),
        );

        if (typeof ctx.effect === "function") {
          ctx.effect(() => () => {
            for (const dispose of disposers.splice(0)) {
              try {
                if (typeof dispose === "function") dispose();
              } catch {
                /* 忽略 */
              }
            }
          }, NS + ": teardown");
        }
      } catch (error) {
        console.warn(
          "[" + NS + "] 客户端初始化失败（界面降级，不影响 DSH 启动）：" +
            String(error && error.message ? error.message : error),
        );
      }
    }

    const module = { exports: {} };
    module.exports.name = NS;
    module.exports.inject = inject;
    module.exports.apply = apply;
    return module.exports;
  },
});
