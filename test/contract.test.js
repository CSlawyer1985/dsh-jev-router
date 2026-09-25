import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');

const hostSource = read('lib/index.js');
const clientSource = read('client/client.js');
const pkg = JSON.parse(read('package.json'));
const patch = read('cordis.patch.yml');

// ── 核心不变量：判定永不进入 prompt 前缀 ──────────────────────
test('契约：Host 半不得改写 messages', () => {
  assert.ok(!/\.messages\s*=/.test(hostSource), 'agent/request 不得改写 messages —— 那会破坏前缀缓存');
});

test('契约：Host 半不得注册 systemPrompt 的 section/context', () => {
  assert.ok(!/systemPrompt/.test(hostSource), '判定结果不得注入 system prompt —— 那会让每轮前缀都变');
});

test('契约：agent/request 的替换对象只允许出现 LlmCallConfig 里的字段', () => {
  // 抓出 `replacement.xxx =` 的所有赋值字段名
  const assigned = [...hostSource.matchAll(/replacement\.([A-Za-z]+)\s*=/g)].map((m) => m[1]);
  assert.ok(assigned.length > 0, '应当至少赋值 reasoningEffort');

  // LlmCallConfig = {provider, model, reasoningEffort?, temperature?, maxTokens?, stop?}
  // provider 在支持 `provider::model` 跨 provider 路由后是必需的；
  // 关键是**不能**出现 messages / system / tools 这类会改变前缀的字段。
  const allowed = new Set(['reasoningEffort', 'model', 'provider']);
  for (const field of assigned) {
    assert.ok(allowed.has(field), `不允许改写 LlmCallConfig.${field}`);
  }
  for (const forbidden of ['messages', 'system', 'tools', 'toolHistory']) {
    assert.ok(!assigned.includes(forbidden), `绝不能赋值 ${forbidden} —— 那会重写 prompt 前缀`);
  }
});

test('契约：provider 只能与 model 成对切换（避免 provider 与 model 错配）', () => {
  const compact = hostSource.replace(/\s+/g, ' ');
  assert.ok(
    compact.includes('replacement.provider = targetProvider; replacement.model = targetModel;'),
    'provider 与 model 必须在同一处一起赋值',
  );
});

test('契约：模型切换必须同时经过硬门禁与成本闸', () => {
  assert.ok(hostSource.includes('shouldSwitchModel'), '必须走策略层裁决');
  assert.ok(!/replacement\.model\s*=\s*candidate/.test(hostSource.replace(/\s+/g, ' ')) || hostSource.includes('verdict.allow'), '改模型前必须检查 verdict.allow');
});

// ── 打包与挂载 ──────────────────────────────────────────────
test('打包：声明 dsh.bundle.patch 与 dsh.client', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.main, 'lib/index.js');
  assert.ok(pkg.exports['./client']);
});

test('打包：作者标识为 chenshi.ai', () => {
  assert.equal(pkg.author, 'chenshi.ai');
  assert.equal(pkg.homepage, 'https://chenshi.ai');
});

test('打包：cordis.patch.yml 的 entry id 与默认 namespace 一致', () => {
  const match = patch.match(/^\s*-\s*id:\s*(\S+)/m);
  assert.ok(match, 'patch 必须有一个 insert entry id');
  const id = match[1].replace(/['"]/g, '');

  const declared = read('lib/namespace.js').match(/DEFAULT_NAMESPACE\s*=\s*'([^']+)'/);
  assert.ok(declared, 'lib/namespace.js 必须声明 DEFAULT_NAMESPACE');
  assert.equal(declared[1], id, `loader entry id (${id}) 必须等于 DEFAULT_NAMESPACE (${declared[1]})，否则 /jev 写的配置与挂载 id 不一致`);
});

test('打包：name 字段与 client 模块 id 一致', () => {
  assert.ok(clientSource.includes(`id: "dsh-jev-router"`));
  assert.ok(hostSource.includes(`export const name = 'dsh-jev-router'`));
});

// ── 配置 schema 的 DSH 约定 ─────────────────────────────────
test('契约：运行时可改的字段必须标注 volatile（否则 settings.update 会被拒绝）', () => {
  const settings = read('lib/settings.js');
  const operational = [
    'enabled',
    'effort',
    'confidenceFloor',
    'fallbackEffort',
    'hysteresisRounds',
    'downgradeStreak',
    'timeoutMs',
    'blockOnDecision',
    'modelRouting',
    'acknowledgeCacheRisk',
    'modelSwitchMode',
    'modelAllowlist',
    'modelNotes',
    'customPricing',
    'stickyRounds',
    'switchCooldown',
    'maxSwitchesPerSession',
    'hitRateAlert',
    'skillRouting',
    'holidays',
    'showBadge',
  ];
  for (const field of operational) {
    assert.ok(
      new RegExp(`\\b${field}:\\s*tunable\\(`).test(settings),
      `字段 ${field} 必须通过 tunable(...) 声明 volatile —— DSH 拒绝写入非 volatile 字段`,
    );
  }
});

test('契约：结构性字段保持非 volatile（语义上需要重启才生效）', () => {
  const settings = read('lib/settings.js');
  for (const field of ['pricingAutoRefreshHours', 'pricingCachePath', 'namespace']) {
    assert.ok(
      new RegExp(`\\b${field}:\\s*z\\n?\\s*\\.`).test(settings) || new RegExp(`\\b${field}:\\s*z\\.`).test(settings),
      `字段 ${field} 不应标注 volatile`,
    );
  }
});

// ── 前端半的独立性 ──────────────────────────────────────────
test('前端半：不依赖 ui-primitives（避免契约耦合）', () => {
  assert.ok(!/dsh-client-ui-primitives/.test(clientSource), '首版只用 React + 内联样式');
});

test('前端半：通过同源路由取数，并使用 slots.register', () => {
  assert.ok(clientSource.includes('/jev-router/status'));
  assert.ok(clientSource.includes('settings.section'));
  assert.ok(clientSource.includes('conversation.input.left'));
});

// ── volatile 配置读取（实机启动才暴露的那一类） ──────────────
/** 去掉注释再断言，避免文档里提到某个写法就被误判成使用了它。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('契约：不得直接读 config 字段（volatile 字段是引用对象，必须走 readConfig）', () => {
  const code = stripComments(hostSource);
  const bare = [...code.matchAll(/\blive\.([A-Za-z]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    bare,
    [],
    `发现直读 live.${bare.join(', live.')} —— volatile 字段在运行时是 {get:…} 引用对象，` +
      '直读会让 `=== true` / `<` 比较静默失效，必须经 readConfig()/C() 取值',
  );
});

test('契约：策略层的 config 必须来自 resolveConfig（裸值），不能直接传 loader 的配置对象', () => {
  const code = stripComments(hostSource);
  assert.ok(/config:\s*policyConfig\(\)/.test(code), 'decideEffort / shouldSwitchModel 必须收到解析后的裸值配置');
  // 精确定位两处策略调用，确认它们拿到的是 policyConfig() 而不是 live
  for (const call of ['decideEffort({', 'shouldSwitchModel({']) {
    const start = code.indexOf(call);
    assert.ok(start >= 0, `找不到 ${call}`);
    const block = code.slice(start, start + 400);
    assert.ok(block.includes('config: policyConfig()'), `${call} 必须收到 policyConfig()`);
    assert.ok(!/config:\s*live\b/.test(block), `${call} 不得收到 loader 的原始配置对象`);
  }
});

test('契约：配置默认值只有一个真源（DEFAULTS），schema 不得硬编码', () => {
  const settings = stripComments(read('lib/settings.js'));
  assert.ok(settings.includes("from './config.js'"), 'settings.js 必须从 config.js 取默认值');
  assert.ok(settings.includes('DEFAULTS.'), 'schema 应当使用 DEFAULTS.<key>');
  // 找出仍然硬编码字面量默认值的地方（.default(true) / .default('auto') 之类）
  const hardcoded = [...settings.matchAll(/\.default\((?!DEFAULTS\.)[^)]+\)/g)].map((m) => m[0]);
  assert.deepEqual(hardcoded, [], `schema 里仍有硬编码默认值：${hardcoded.join(', ')}`);
});
