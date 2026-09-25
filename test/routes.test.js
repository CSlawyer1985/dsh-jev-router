import test from 'node:test';
import assert from 'node:assert/strict';

import { registerRoutes, __test__ } from '../lib/routes.js';

const { trustedRequest } = __test__;

test('同源校验：无 Origin 的请求放行（非浏览器 / 同源 GET）', () => {
  assert.equal(trustedRequest({ headers: {} }), true);
  assert.equal(trustedRequest({ headers: { origin: '' } }), true);
});

test('同源校验：Origin 与 Host 一致时放行', () => {
  assert.equal(trustedRequest({ headers: { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387' } }), true);
});

test('同源校验：跨站 Origin 拒绝', () => {
  assert.equal(trustedRequest({ headers: { origin: 'https://evil.example', host: '127.0.0.1:19387' } }), false);
});

test('同源校验：畸形 Origin 拒绝', () => {
  assert.equal(trustedRequest({ headers: { origin: 'not-a-url', host: '127.0.0.1:19387' } }), false);
});

test('没有 webServer 服务时注册是安全的空操作', () => {
  const ctx = { get: () => undefined };
  const dispose = registerRoutes(ctx, {});
  assert.equal(typeof dispose, 'function');
  assert.doesNotThrow(() => dispose());
});
