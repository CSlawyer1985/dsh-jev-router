/**
 * 前端半测试：把 client.js 真正执行一遍。
 *
 * 为什么需要它：静态 client 模块要等浏览器加载才会运行，在那之前它是
 * 唯一"从未运行过"的代码。这组测试用桩 React 与**仿真的 slot 系统**把
 * 模块装载、apply、并把组件真正 render 一次。
 *
 * ⚠️ slot 桩必须仿真真实语义，否则会漏掉真 bug：
 * 真实的 `slots.register` 在槽位未被属主插件声明时会抛
 *   slot "<name>" is not declared (a parent entry's children table must declare it)
 * 而槽位声明与插件 apply 的**顺序没有保证**。正因为桩原本不抛，
 * 才让"必须走 slots.inject"这个 bug 溜过了测试，最终导致
 * web boot 失败、DSH 只能用安全模式启动。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 React 替身：只够组件函数体跑完。 */
function createReactStub() {
  const seen = [];
  return {
    seen,
    createElement(type, props, ...children) {
      const node = {
        type,
        props: props ?? {},
        children: children.flat().filter((c) => c !== null && c !== undefined),
      };
      seen.push(node);
      return node;
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    // 不执行 effect：同步执行会因 setState 触发无限渲染。
    // 需要 status 不为 null 的测试，直接用源码断言（见占位徽章那条）。
    useEffect() {},
    useCallback(fn) {
      return fn;
    },
    useMemo(fn) {
      return fn();
    },
    useRef(value) {
      return { current: value };
    },
  };
}

/**
 * 深度遍历元素树，收集所有文本。
 * 函数组件必须被**调用**才算真的渲染过。
 */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  if (typeof node.type === 'function') {
    textOf(node.type(node.props ?? {}), out);
    return out;
  }
  for (const child of node.children ?? []) textOf(child, out);
  return out;
}

/** 去掉注释再断言，避免文档里提到某个 API 就被误判成使用了它。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 仿真 slot 系统。
 *
 * - `register` 在槽位未声明时**抛错**（与真实实现一致）
 * - `inject` 在槽位未声明时**挂起回调**，声明后补跑
 */
function createSlotStub({ declared = [] } = {}) {
  const declaredSet = new Set(declared);
  const registrations = [];
  const pending = [];
  const slots = {
    register(declaration, render) {
      if (!declaredSet.has(declaration.name)) {
        throw new Error(
          `slot "${declaration.name}" is not declared (a parent entry's children table must declare it)`,
        );
      }
      registrations.push({ declaration, render });
      return () => {};
    },
    inject(name, callback) {
      if (declaredSet.has(name)) {
        const dispose = callback();
        return typeof dispose === 'function' ? dispose : () => {};
      }
      pending.push({ name, callback });
      return () => {};
    },
  };
  return {
    slots,
    registrations,
    get pendingCount() {
      return pending.length;
    },
    declare(name) {
      declaredSet.add(name);
      // 只补跑匹配的挂起项，其余必须留下 —— 一次性清空会丢掉别的槽位。
      const keep = [];
      for (const item of pending.splice(0)) {
        if (item.name === name) item.callback();
        else keep.push(item);
      }
      pending.push(...keep);
    },
    isDeclared: (name) => declaredSet.has(name),
  };
}

/** 装载 client.js。 */
function loadClientModule({ declaredSlots = [], slotsAvailable = true } = {}) {
  const source = readFileSync(join(ROOT, 'client/client.js'), 'utf8');
  const react = createReactStub();

  let loaded = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        loaded = spec;
      },
    },
  };
  const fakeRequire = (name) => {
    if (name === 'react') return react;
    throw new Error(`unexpected require: ${name}`);
  };

  new Function('window', 'require', 'console', source)(fakeWindow, fakeRequire, console);

  assert.ok(loaded, 'client.js 必须通过 window.__ModuleLoader__.load 注册自己');
  assert.equal(loaded.id, 'dsh-jev-router');

  const mod = loaded.factory(fakeRequire);
  const slotStub = slotsAvailable ? createSlotStub({ declared: declaredSlots }) : null;
  const warnings = [];
  const effects = [];
  const ctx = {
    ...(slotStub ? { slots: slotStub.slots } : {}),
    get: (name) => (name === 'slots' ? slotStub?.slots : undefined),
    effect(callback) {
      effects.push(callback());
      return () => {};
    },
  };
  // 捕获警告，用于断言「降级而不是抛错」
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const restoreWarn = () => {
    console.warn = originalWarn;
  };

  return { mod, react, ctx, slotStub, warnings, effects, restoreWarn };
}

// ── 模块形状 ────────────────────────────────────────────────
test('前端半：模块以正确形状导出（name / inject / apply）', () => {
  const { mod, restoreWarn } = loadClientModule();
  try {
    assert.equal(mod.name, 'dsh-jev-router');
    assert.ok(Array.isArray(mod.inject));
    assert.equal(typeof mod.apply, 'function');
  } finally {
    restoreWarn();
  }
});

// ── 本次事故的回归：槽位声明顺序 ─────────────────────────────
test('回归：槽位尚未声明时 apply 绝不能抛（真实事故：导致 DSH 只能用安全模式启动）', () => {
  // 事故现场：属主插件还没声明槽位。
  // 修复前直接 register → 抛 "is not declared" → client fiber FAILED →
  // 前端启动检查判定 "web boot: 1 entry did not activate / dsh-jev-router: failed"。
  const { mod, ctx, slotStub, restoreWarn } = loadClientModule({ declaredSlots: [] });
  try {
    assert.doesNotThrow(() => mod.apply(ctx), 'apply 抛错会让整个 DSH 起不来');
    assert.equal(slotStub.registrations.length, 0, '槽位还没声明，不应注册成功');
    assert.equal(slotStub.pendingCount, 2, '两个槽位都应当挂起等待声明');
  } finally {
    restoreWarn();
  }
});

test('回归：属主插件稍后声明槽位时，挂起的注册必须补跑', () => {
  const { mod, ctx, slotStub, restoreWarn } = loadClientModule({ declaredSlots: [] });
  try {
    mod.apply(ctx);
    assert.equal(slotStub.registrations.length, 0);

    slotStub.declare('settings.section');
    assert.equal(slotStub.registrations.length, 1, '声明后应当立刻补上注册');
    assert.equal(slotStub.registrations[0].declaration.name, 'settings.section');

    slotStub.declare('conversation.input.left');
    assert.equal(slotStub.registrations.length, 2);

    const names = slotStub.registrations.map((r) => r.declaration.name).sort();
    assert.deepEqual(names, ['conversation.input.left', 'settings.section']);
  } finally {
    restoreWarn();
  }
});

test('槽位桩本身忠实于真实语义：未声明时 register 会抛', () => {
  // 这条测试保护桩的保真度——桩一旦变得宽容，上面的回归就会失效。
  const stub = createSlotStub({ declared: [] });
  assert.throws(() => stub.slots.register({ name: 'settings.section' }, () => null), /is not declared/);
});

test('槽位已声明时立即注册（不引入额外延迟）', () => {
  const { mod, ctx, slotStub, restoreWarn } = loadClientModule({
    declaredSlots: ['settings.section', 'conversation.input.left'],
  });
  try {
    mod.apply(ctx);
    assert.equal(slotStub.pendingCount, 0);
    assert.equal(slotStub.registrations.length, 2);

    const section = slotStub.registrations.find((r) => r.declaration.name === 'settings.section');
    assert.equal(section.declaration.id, 'jev-router');
    assert.equal(typeof section.declaration.label, 'function');
    assert.equal(section.declaration.label(), 'Jev 路由');

    const badge = slotStub.registrations.find((r) => r.declaration.name === 'conversation.input.left');
    assert.equal(badge.declaration.id, 'jev-router-badge');
  } finally {
    restoreWarn();
  }
});

test('兜底：即便 register 永远抛错，apply 也必须安全返回', () => {
  const react = createReactStub();
  const source = readFileSync(join(ROOT, 'client/client.js'), 'utf8');
  let loaded = null;
  const fakeWindow = { __ModuleLoader__: { load: (spec) => { loaded = spec; } } };
  new Function('window', 'require', 'console', source)(
    fakeWindow,
    (name) => (name === 'react' ? react : null),
    console,
  );
  const mod = loaded.factory((name) => (name === 'react' ? react : null));

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const broken = {
      register() {
        throw new Error('boom');
      },
      inject(_name, callback) {
        return callback(); // 立刻执行，让 register 的抛错冒到 apply
      },
    };
    assert.doesNotThrow(() => mod.apply({ slots: broken, effect: () => () => {} }));
    assert.ok(warnings.some((w) => w.includes('settings.section')), '应当留下降级告警');
  } finally {
    console.warn = originalWarn;
  }
});

test('slots 服务缺失时安全降级，不抛错', () => {
  const { mod, ctx, warnings, restoreWarn } = loadClientModule({ slotsAvailable: false });
  try {
    assert.doesNotThrow(() => mod.apply(ctx));
    assert.ok(warnings.some((w) => w.includes('slots 服务不可用')));
  } finally {
    restoreWarn();
  }
});

// ── 渲染 ────────────────────────────────────────────────────
test('设置页能真正渲染出来（无引用错误），并包含全部关键区块', () => {
  const { mod, ctx, slotStub, restoreWarn } = loadClientModule({
    declaredSlots: ['settings.section', 'conversation.input.left'],
  });
  try {
    mod.apply(ctx);
    const section = slotStub.registrations.find((r) => r.declaration.name === 'settings.section');
    const text = textOf(section.render()).join(' | ');

    assert.match(text, /缓存与成本/, '缺失度量区块');
    assert.match(text, /思考强度路由/, '缺失 Tier A 区块');
    assert.match(text, /自动模型路由/, '缺失 Tier B 区块');
    assert.match(text, /价目/, '缺失价目区块');
    assert.match(text, /chenshi\.ai/, '缺失作者署名');
    assert.match(text, /命中率/, '缺失命中率指标');
    assert.match(text, /Jev API Key/, '缺失 Key 配置区块');
    // 一行三按钮：保存 / 连通 / 清除
    assert.match(text, /保存/);
    assert.match(text, /连通/);
    assert.match(text, /清除/);
    // 密钥永不回显：渲染结果里不得出现任何 Key 内容，也不得出现凭据名以外的键值
    assert.ok(!/ts_[A-Za-z0-9]/.test(text), '渲染结果里不得出现 Key 本体');
    assert.match(text, /不会回显/, '应当告知用户密钥不回显');
    // 极简版刻意不在界面上堆说明文字；申请入口放在 README 的「使用」一节。
    assert.match(text, /DSH 凭据存储/, '应当说明密钥存放在哪里');
  } finally {
    restoreWarn();
  }
});

test('徽章能渲染，初始态是读取中而不是崩溃', () => {
  const { mod, ctx, slotStub, restoreWarn } = loadClientModule({
    declaredSlots: ['settings.section', 'conversation.input.left'],
  });
  try {
    mod.apply(ctx);
    const badge = slotStub.registrations.find((r) => r.declaration.name === 'conversation.input.left');
    const text = textOf(badge.render()).join('');
    assert.match(text, /⚡/);
    assert.match(text, /auto/, '未取到状态时应显示 auto 兜底');
  } finally {
    restoreWarn();
  }
});

test('设置页初始不展开 Tier B 确认流程', () => {
  const { mod, ctx, slotStub, restoreWarn } = loadClientModule({
    declaredSlots: ['settings.section', 'conversation.input.left'],
  });
  try {
    mod.apply(ctx);
    const section = slotStub.registrations.find((r) => r.declaration.name === 'settings.section');
    const text = textOf(section.render()).join(' | ');
    assert.ok(!/第 1 步/.test(text), '初始不应展开确认流程');
    assert.match(text, /启用自动模型路由/);
  } finally {
    restoreWarn();
  }
});

// ── 依赖与协议 ──────────────────────────────────────────────
test('前端半：不依赖 host.call（静态模块没有该能力）', () => {
  const source = stripComments(readFileSync(join(ROOT, 'client/client.js'), 'utf8'));
  assert.ok(!/host\.call/.test(source));
  assert.ok(/fetch\(/.test(source));
});

test('前端半：写入请求带同源 JSON 头，且刷新价目走 POST', () => {
  const source = readFileSync(join(ROOT, 'client/client.js'), 'utf8');
  assert.match(source, /content-type": "application\/json"/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /\/jev-router\/pricing\/refresh/);
});

test('前端半：槽位注册必须走 slots.inject（不能裸 register）', () => {
  const source = stripComments(readFileSync(join(ROOT, 'client/client.js'), 'utf8'));
  assert.ok(source.includes('slots.inject('), '必须用 slots.inject 等待槽位声明');
  assert.ok(
    !/slots\.register\(\s*\{\s*name:\s*"settings\.section"/.test(source),
    '不得裸调 register —— 槽位未声明时会抛错并让 DSH 起不来',
  );
});

test('设置页必须暴露全部可调项，而不是只给几个开关', () => {
  // 用户的实际反馈：「设置页没有可以调整的地方」。
  // 根因之一就是页面只渲染了 4 个控件，其余配置项在插件页里根本不存在。
  const { mod, ctx, slotStub, restoreWarn } = loadClientModule({
    declaredSlots: ['settings.section', 'conversation.input.left'],
  });
  let text;
  try {
    mod.apply(ctx);
    const section = slotStub.registrations.find((r) => r.declaration.name === 'settings.section');
    text = textOf(section.render()).join(' | ');
  } finally {
    restoreWarn();
  }
  const tunable = [
    '置信度门',
    '低代价降档上界',
    '降档连续确认轮数',
    '迟滞窗口',
    '判定超时',
    '关键词回退默认档位',
    '首步等待判定',
    '输入框档位徽章',
    '候选连续胜出轮数',
    '切换冷却',
    '单会话切换上限',
    '命中率告警阈值',
    '上下文窗口安全余量',
  ];
  for (const label of tunable) {
    assert.ok(text.includes(label), `设置页缺少可调项：${label}`);
  }
});

test('回归：会话未就绪时的占位徽章绝不能有副作用（曾把全局档位改成 off）', () => {
  // 真实事故：占位按钮的 onClick 写了 postConfig({effort: 下一档})，
  // 用户点一下就把**全局**手动档位从 auto 改成 off，
  // 从此所有会话都被 manual-override 钉死、Jev 判定被完全绕过，
  // 现象是「思考强度完全不变化」。
  //
  // 这里用源码结构断言：占位分支必须是 disabled 且没有 onClick。
  // （不渲染真实节点，因为测试桩不执行 effect，status 恒为 null。）
  const src = stripComments(readFileSync(join(ROOT, 'client/client.js'), 'utf8'));
  const i = src.indexOf('if (status && !exact) {');
  assert.ok(i > 0, '应当存在"会话未就绪"的占位分支');
  const block = src.slice(i, src.indexOf('const effort = status && status.session', i));
  assert.match(block, /disabled:\s*true/, '占位徽章必须 disabled');
  assert.ok(!/onClick/.test(block), '占位徽章绝不能带 onClick —— 那会写全局配置');
  assert.match(block, /⚡ \?/);
});

test('手动钉死档位时，徽章必须用 🔒 标出来（否则会被当成自动调节失效）', () => {
  const src = stripComments(readFileSync(join(ROOT, 'client/client.js'), 'utf8'));
  assert.match(src, /isManual \? "🔒 " : "⚡ "/, '徽章应区分手动与自动');
  assert.match(src, /manual-override/, '应识别 manual-override 裁决原因');
});

test('回归：showBadge=false 必须真的不渲染徽章（这个开关曾是死的）', () => {
  // 真实缺陷：徽章无条件注册，`showBadge` 只在设置页的开关上被读、
  // 从未参与判断，于是"关掉徽章"是个无效开关。
  const src = stripComments(readFileSync(join(ROOT, 'client/client.js'), 'utf8'));
  assert.match(src, /function BadgeIfEnabled/, '应存在按开关渲染的包装组件');
  assert.match(
    src,
    /status\.config\.showBadge === false\) return null/,
    'showBadge 为 false 时必须返回 null（不渲染）',
  );
  // 注册的渲染函数必须走包装组件，而不是直接渲染 JevBadge
  const i = src.indexOf('{ id: "jev-router-badge"');
  const block = src.slice(i, i + 200);
  assert.match(block, /BadgeIfEnabled/, '注册处必须使用包装组件');
  assert.ok(!/h\(JevBadge/.test(block), '注册处不得直接渲染 JevBadge（会绕过开关）');
});

test('设置页必须暴露上下文窗口安全余量（新闸的可调项）', () => {
  const { mod, ctx, slotStub, restoreWarn } = loadClientModule({
    declaredSlots: ['settings.section', 'conversation.input.left'],
  });
  let text;
  try {
    mod.apply(ctx);
    const section = slotStub.registrations.find((r) => r.declaration.name === 'settings.section');
    text = textOf(section.render()).join(' | ');
  } finally {
    restoreWarn();
  }
  assert.match(text, /上下文窗口安全余量/, '设置页应能调这个新闸');
});
