/**
 * 前端半的取数桥：同源 HTTP 路由。
 *
 * 静态 client 模块没有 host.call（那是动态插件 runner 的能力），
 * 因此客户端通过同源 fetch 读取本插件 Host 半注册的路由——
 * 这也是本仓库中 dshmarket 使用的既有模式。
 *
 * 读接口只读；写接口做同源回环校验（参考 dshmarket 的做法）。
 */

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function readBody(request, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${String(error?.message ?? error)}`));
      }
    });
    request.on('error', reject);
  });
}

/** 仅接受同源回环请求（浏览器同源 fetch 会带上匹配 Host 的 Origin）。 */
function trustedRequest(request) {
  const origin = request.headers?.origin;
  if (origin === undefined || origin === '') return true; // 非浏览器或同源 GET
  const host = request.headers?.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function firstAgent(runtime) {
  const agents = runtime.ctx?.get?.('agents');
  const list = agents?.list?.() ?? [];
  return list[0] ?? null;
}

/**
 * 注册路由。
 *
 * @param {object} ctx Cordis host context
 * @param {object} runtime 插件运行时（见 lib/index.js）
 * @returns {() => void} 反注册
 */
export function registerRoutes(ctx, runtime) {
  const webServer = ctx.get('webServer');
  if (!webServer?.register) return () => {};
  const disposers = [];

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/jev-router/status',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' });
          response.end();
          return;
        }
        try {
          const agent = firstAgent(runtime);
          // snapshotForClient 是 async 的——必须 await，
          // 否则 JSON.stringify(Promise) 会静默产出 "{}"。
          sendJson(response, 200, await runtime.snapshotForClient(agent));
        } catch (error) {
          sendJson(response, 500, { error: String(error?.message ?? error) });
        }
      },
    }),
  );

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/jev-router/config',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' });
          response.end();
          return;
        }
        if (!trustedRequest(request)) {
          sendJson(response, 403, { ok: false, error: 'same-origin loopback requests only' });
          return;
        }
        try {
          const body = await readBody(request);
          const patch = body && typeof body.patch === 'object' && body.patch !== null ? body.patch : null;
          if (patch === null) {
            sendJson(response, 400, { ok: false, error: 'expected { patch: {...} }' });
            return;
          }
          const result = await runtime.setConfig(patch);
          sendJson(response, result.ok ? 200 : 409, result);
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
  );

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/jev-router/pricing/refresh',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' });
          response.end();
          return;
        }
        if (!trustedRequest(request)) {
          sendJson(response, 403, { ok: false, error: 'same-origin loopback requests only' });
          return;
        }
        try {
          const result = await runtime.refreshPricing();
          sendJson(response, 200, result);
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
  );

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/jev-router/credential',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' });
          response.end();
          return;
        }
        if (!trustedRequest(request)) {
          sendJson(response, 403, { ok: false, error: 'same-origin loopback requests only' });
          return;
        }
        try {
          const body = await readBody(request);
          // clear:true 清除；否则写入 value。密钥只进凭据存储，绝不写进 profile 配置。
          const result =
            body && body.clear === true
              ? await runtime.clearCredential()
              : await runtime.setCredential(body ? body.value : undefined);
          sendJson(response, result.ok ? 200 : 409, result);
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
  );

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.();
      } catch {
        /* 反注册失败不应影响卸载 */
      }
    }
  };
}

export const __test__ = { trustedRequest, sendJson, readBody };
