import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionStore, DEFAULT_TTL_MS, DEFAULT_CAP } from '../lib/session-store.js';

/** 可控时钟，避免测试里 sleep。 */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      return t;
    },
  };
}

test('forSession: 同一会话只创建一次，返回同一个记录对象', () => {
  const clock = fakeClock();
  const store = createSessionStore({ now: clock.now });
  let created = 0;
  const make = () => {
    created += 1;
    return { value: created };
  };

  const a = store.forSession('s1', make);
  const b = store.forSession('s1', make);

  assert.equal(created, 1, '第二次必须复用而不是重建');
  assert.equal(a, b);
  assert.equal(a.value, 1);
  assert.equal(store.size, 1);
  assert.equal(store.stats.created, 1);
});

test('forSession: 不同会话各自独立', () => {
  const store = createSessionStore({ now: fakeClock().now });
  const a = store.forSession('s1', () => ({ id: 'a' }));
  const b = store.forSession('s2', () => ({ id: 'b' }));
  assert.notEqual(a, b);
  assert.equal(store.size, 2);
});

test('forSession: 给记录补上 createdAt / lastSeenAt / key', () => {
  const clock = fakeClock(5000);
  const store = createSessionStore({ now: clock.now });
  const entry = store.forSession('abc', () => ({ anything: true }));
  assert.equal(entry.createdAt, 5000);
  assert.equal(entry.lastSeenAt, 5000);
  assert.equal(entry.key, 'abc');
  assert.equal(entry.anything, true, 'store 不得包装或改名调用方的字段');
});

test('回归：create() 返回的记录不会被额外包一层 state', () => {
  // 早先的实现写成 `entry = { state: create() }`，调用方拿到的是
  // `{state:{state:…}}`，于是 entry.state.history 直接 undefined。
  const store = createSessionStore({ now: fakeClock().now });
  const entry = store.forSession('s1', () => ({ state: { history: [] }, other: 1 }));
  assert.ok(entry.state, 'entry.state 必须存在');
  assert.equal(entry.state.state, undefined, '不得出现双层 state');
  assert.ok(Array.isArray(entry.state.history));
});

test('过期淘汰：TTL 之内保留，超过之后回收', () => {
  const clock = fakeClock();
  const store = createSessionStore({ now: clock.now, ttlMs: 1000 });
  store.forSession('s1', () => ({ n: 1 }));

  clock.advance(999);
  store.forSession('s2', () => ({ n: 2 })); // 触发 sweep
  assert.equal(store.size, 2, '还没到期，两个都该在');

  // t=1599：s1 已过期 1599ms；s2 距上次访问 600ms，仍在 TTL 内
  clock.advance(600);
  store.forSession('s3', () => ({ n: 3 }));
  assert.equal(store.get('s1'), undefined, 's1 应当被回收');
  assert.ok(store.get('s2'), 's2 刚被访问过，应当保留');
  assert.ok(store.get('s3'));
  assert.ok(store.stats.evicted >= 1);
});

test('LRU：超过容量时淘汰最久未使用的会话', () => {
  const clock = fakeClock();
  const store = createSessionStore({ now: clock.now, cap: 3, ttlMs: DEFAULT_TTL_MS });

  store.forSession('a', () => ({ n: 'a' }));
  clock.advance(10);
  store.forSession('b', () => ({ n: 'b' }));
  clock.advance(10);
  store.forSession('c', () => ({ n: 'c' }));
  clock.advance(10);
  store.touch('a'); // a 变成最近使用
  clock.advance(10);

  store.forSession('d', () => ({ n: 'd' })); // 触发容量淘汰

  assert.equal(store.size, 3);
  assert.equal(store.get('b'), undefined, 'b 最久未使用，应当被淘汰');
  assert.ok(store.get('a') && store.get('c') && store.get('d'));
});

test('touch: 只刷新活动时间，不动记录内容', () => {
  const clock = fakeClock();
  const store = createSessionStore({ now: clock.now, ttlMs: 1000 });
  const entry = store.forSession('s1', () => ({ n: 1 }));
  const before = entry.lastSeenAt;
  clock.advance(500);
  const after = store.touch('s1');
  assert.equal(after, entry);
  assert.ok(entry.lastSeenAt > before);
  assert.equal(entry.n, 1);
});

test('touch: 不存在的会话返回 undefined，不创建', () => {
  const store = createSessionStore({ now: fakeClock().now });
  assert.equal(store.touch('nope'), undefined);
  assert.equal(store.size, 0);
});

test('stats: disposedSignals 由调用方累加，store 不据此删状态', () => {
  // 这是本 bug 的核心：agent 每轮结束都会被注销一次。
  // store 只计数，状态的去留由 TTL/LRU 决定。
  const store = createSessionStore({ now: fakeClock().now });
  const entry = store.forSession('s1', () => ({ n: 1 }));
  store.stats.disposedSignals += 1;
  store.stats.disposedSignals += 1;

  assert.equal(entry.n, 1, '收到 disposal 信号后状态必须还在');
  assert.equal(store.stats.disposedSignals, 2);
  assert.equal(store.stats.evicted, 0, 'disposal 不应产生淘汰');
});

test('默认值：TTL 30 分钟、容量 32', () => {
  assert.equal(DEFAULT_TTL_MS, 30 * 60 * 1000);
  assert.equal(DEFAULT_CAP, 32);
});

test('未知 id 归一到同一个键，不会为每次调用新建条目', () => {
  const store = createSessionStore({ now: fakeClock().now });
  const a = store.forSession(undefined, () => ({ n: 1 }));
  const b = store.forSession(undefined, () => ({ n: 2 }));
  assert.equal(a, b);
  assert.equal(store.size, 1);
});
