/**
 * 会话级状态存储。
 *
 * 为什么单独抽出来：DSH 会在一轮驱动**空闲之后**注销 agent 并派发
 * `agent/disposed`（源码注释：*"An agent left the registry; AgentLoop emits this
 * after driver quiescence and separately from session detachment"*）。
 *
 * 如果在这个事件上直接删掉会话状态，就等于**每轮清空一次策略状态**：
 *   - `lowStreak` 永远累不到 `downgradeStreak` → 降档永远不会发生
 *   - `pendingModelStreak` 永远累不到 `stickyRounds` → Tier B 的粘滞闸永不放行
 *   - `switches` 预算每轮重置 → 单会话切换上限形同虚设
 *   - `roundsSinceEffortChange` 永远停在初值 → 迟滞窗口永不生效
 *
 * 正确的生命周期是**会话**，不是 agent 实例：agent 随轮次生灭，会话跨轮次持续。
 * 因此这里按会话 id 保留状态，用 TTL + LRU 上限做淘汰，而不是依赖 disposal 事件。
 */

/**
 * 这里存放的是**任意会话记录**（调用方决定其形状），store 只负责
 * 它的生命周期：按会话 id 取用、刷新活动时间、TTL + LRU 淘汰。
 */

/** 状态保留时长：超过这么久没有活动就淘汰。 */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** 同时保留的会话数上限。 */
export const DEFAULT_CAP = 32;

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs]
 * @param {number} [options.cap]
 * @param {() => number} [options.now] 注入时钟，便于测试
 */
export function createSessionStore({ ttlMs = DEFAULT_TTL_MS, cap = DEFAULT_CAP, now = () => Date.now() } = {}) {
  /** @type {Map<string, {createdAt: number, lastSeenAt: number, key: string}>} */
  const entries = new Map();

  const stats = {
    /** 新建过多少个会话条目（用于诊断"状态是否被每轮重建"）。 */
    created: 0,
    /** 因 TTL/容量被淘汰的条目数。 */
    evicted: 0,
    /** 收到过多少次 agent/disposed（只计数，不删状态）。 */
    disposedSignals: 0,
  };

  /**
   * 淘汰过期与超量的条目。
   *
   * 注意：`lastSeenAt` 只在**访问**时更新，因此一个长时间没人说话的会话
   * 会被回收；而正在进行的会话即使 agent 被反复注销也会一直留着。
   */
  function sweep(at = now()) {
    for (const [key, entry] of entries) {
      if (at - entry.lastSeenAt > ttlMs) {
        entries.delete(key);
        stats.evicted += 1;
      }
    }
    if (entries.size > cap) {
      const byAge = [...entries.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
      for (const [key] of byAge.slice(0, entries.size - cap)) {
        entries.delete(key);
        stats.evicted += 1;
      }
    }
  }

  /**
   * 取（或创建）某个会话的记录，并刷新其活动时间。
   *
   * `create()` 必须返回**完整的会话记录对象**（store 不再额外包装它）——
   * 早先版本把它包成 `{ state: create() }`，导致调用方拿到的是 `{state:{state:…}}`，
   * `entry.state.history` 直接是 undefined。
   */
  function forSession(id, create) {
    const key = String(id ?? 'unknown');
    let entry = entries.get(key);
    if (!entry) {
      const at = now();
      entry = create();
      entry.createdAt = at;
      entry.lastSeenAt = at;
      entry.key = key;
      entries.set(key, entry);
      stats.created += 1;
    } else {
      entry.lastSeenAt = now();
    }
    // 淘汰放在**取用之后**：刚被访问的条目 lastSeenAt 最新，
    // 因此容量收敛不会误伤本次调用（放在插入之前会晚一步，size 会超一）。
    sweep();
    return entry;
  }

  /** 只刷新活动时间，不改状态。 */
  function touch(id) {
    const entry = entries.get(String(id ?? 'unknown'));
    if (entry) entry.lastSeenAt = now();
    return entry;
  }

  function get(id) {
    return entries.get(String(id ?? 'unknown'));
  }

  /**
   * 最近活跃的会话记录。
   *
   * 用途：agent 会在每轮结束后被注销，因此「当前有没有 live agent」是不可靠的。
   * 快照接口在拿不到 live agent 时用它兜底，否则设置页会在两轮之间变成空白。
   */
  function mostRecent() {
    let best = null;
    for (const entry of entries.values()) {
      if (!best || entry.lastSeenAt > best.lastSeenAt) best = entry;
    }
    return best ?? null;
  }

  return {
    forSession,
    touch,
    get,
    mostRecent,
    sweep,
    stats,
    get size() {
      return entries.size;
    },
    keys: () => [...entries.keys()],
  };
}
