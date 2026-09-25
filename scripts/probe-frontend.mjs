/**
 * 前端启动探针：用 CDP 直连 Chrome，验证「web boot 是否成功」以及
 * 本插件的客户端模块是否真的激活并渲染。
 *
 * 为什么必须有它：前端半是唯一在 Node 侧测不到的代码，而它**一旦失败就是致命的**——
 * client fiber 变成 FAILED 会让前端的启动检查判定
 *   web boot: 1 entry did not activate / dsh-jev-router: failed
 * 于是 DSH 直接起不来，用户只能靠「禁用第三方插件…并重启」的安全模式自救。
 * 真实事故就是「槽位未声明时直接 register 抛错」造成的，而当时缺的正是这一层验证。
 *
 * 用法：
 *   1. 先启动一个隔离实例（见 README 的「隔离验证」一节），拿到 ?token=…
 *   2. 启动 Chrome：
 *        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *          --headless=new --disable-gpu --remote-debugging-port=9222 \
 *          --user-data-dir=/tmp/jev-chrome about:blank
 *   3. 运行：
 *        node scripts/probe-frontend.mjs "http://127.0.0.1:19488/?token=<token>" 15000
 *
 * 判定：退出码 0 = 前端启动成功；1 = 出现 "did not activate" 或启动卡片含错误。
 * 输出 JSON 包含：是否仍有启动卡片、页面是否含错误文案、⚡ 徽章是否渲染、
 * 控制台错误、未捕获异常、以及 error 级日志。
 */

const URL_TO_LOAD = process.argv[2];
const WAIT_MS = Number(process.argv[3] ?? 15000);
const DEBUG_PORT = process.env.CDP_PORT ?? '9222';
const BADGE_MARKER = '\u26a1';

if (!URL_TO_LOAD) {
  console.error('usage: node probe.mjs <url> [waitMs]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* Chrome 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('找不到可用的 page target');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleMessages = [];
    this.exceptions = [];
    this.logEntries = [];
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? a.type)
          .join(' ');
        this.consoleMessages.push({ level: msg.params.type, text });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails ?? {};
        this.exceptions.push({
          text: d.exception?.description ?? d.text ?? '(no description)',
        });
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry ?? {};
        this.logEntries.push({ level: e.level, text: e.text ?? '' });
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

const target = await findPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
});

const cdp = new Cdp(ws);
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: URL_TO_LOAD });
await sleep(WAIT_MS);

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
  return result?.result?.value;
}

const probe = await evaluate(`(() => {
  const bootCard = document.querySelector('[data-dsh-boot]');
  const bodyText = (document.body && document.body.innerText) || '';
  return {
    bootCardPresent: Boolean(bootCard),
    bootCardText: bootCard ? bootCard.innerText.slice(0, 400) : null,
    hasNeedle: bodyText.includes('did not activate'),
    hasBadge: bodyText.indexOf(String.fromCharCode(0x26a1)) >= 0,
    hasJevLabel: bodyText.includes('Jev'),
    bodyLength: bodyText.length,
    head: bodyText.slice(0, 200)
  };
})()`);

const payload = {
  url: URL_TO_LOAD,
  probe,
  consoleErrors: cdp.consoleMessages.filter((m) => m.level === 'error').slice(0, 20),
  exceptions: cdp.exceptions.slice(0, 10),
  logErrors: cdp.logEntries.filter((e) => e.level === 'error').slice(0, 20),
};

console.log(JSON.stringify(payload, null, 2));

// 判定：web boot 失败 = 出现 "did not activate" 或启动卡片仍在且含错误
const failed = probe.hasNeedle === true || (probe.bootCardPresent === true && /fail|error/i.test(probe.bootCardText ?? ''));
ws.close();
process.exit(failed ? 1 : 0);
