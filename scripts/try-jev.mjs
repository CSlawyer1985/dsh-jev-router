#!/usr/bin/env node
/**
 * try-jev — 拿真实消息测 Jev 的判定质量。
 *
 * 为什么需要它：关键词表（`think harder` / `ultrathink`）只能做字面匹配，
 * 而 Jev 做的是语义判断。这个脚本把同一批消息同时喂给两者，
 * 让差异直接摆出来——尤其是**否定句**这类关键词表必然判错的场景。
 *
 * 用法：
 *   node scripts/try-jev.mjs                      # 跑内置样例集
 *   node scripts/try-jev.mjs "你的消息" "另一条"   # 跑自己的消息
 *   node scripts/try-jev.mjs --json               # 输出 JSON（便于管道）
 *   node scripts/try-jev.mjs --no-heuristic       # 只看 Jev
 *
 * 凭据：先读环境变量 TYPESAFE_API_KEY / TYPESAFE_KEY，
 *       再读 $DSH_HOME/.credentials.yaml 的 refs 段。**绝不打印密钥**。
 *
 * 零外部依赖：只 import 本仓库的 lib/classify.js 与 lib/jev-client.js。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { buildQuestions, parseDecision, heuristicEffort, EFFORTS } from '../lib/classify.js';
import { JevClient } from '../lib/jev-client.js';

// ── 内置样例集 ────────────────────────────────────────────────
// 前三条是「应该省」的，中间三条是「应该花」的，最后两条是**否定句**——
// 关键词表在这两条上必然判错，正好用来展示语义判断的价值。
const SAMPLES = [
  { text: '你好', why: '纯问候' },
  { text: '今天几号？', why: '简单事实' },
  { text: '把这段 JSON 格式化成两空格缩进', why: '机械操作' },
  { text: '帮我彻底重构这个模块的架构，要考虑并发安全与向后兼容', why: '多步 + 高代价' },
  { text: '这段代码线上偶发超时，日志只有一条 trace id，帮我定位根因', why: '高代价排障' },
  { text: 'ultrathink 一下这个一致性协议有没有漏洞', why: '显式要求穷尽' },
  { text: '不要完整全量思考，简单说就行：这个报错是什么意思', why: '★ 否定句：字面有「完整全量思考」' },
  { text: '别 ultrathink，我只要一个是或否', why: '★ 否定句：字面有「ultrathink」' },
];

// ── 取凭据（不打印） ──────────────────────────────────────────
function readKeyFromCredentials(refName, dshHome) {
  try {
    const text = readFileSync(join(dshHome, '.credentials.yaml'), 'utf8');
    let inRefs = false;
    for (const line of text.split('\n')) {
      if (/^refs:\s*$/.test(line)) {
        inRefs = true;
        continue;
      }
      if (inRefs && /^\S/.test(line)) break; // 离开 refs 段
      if (!inRefs) continue;
      const m = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
      if (!m || m[1] !== refName) continue;
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value.length > 0 ? value : undefined;
    }
  } catch {
    /* 没有该文件就返回 undefined */
  }
  return undefined;
}

function resolveApiKey(refName) {
  const fromEnv = process.env[refName] || process.env.TYPESAFE_API_KEY || process.env.TYPESAFE_KEY;
  if (fromEnv) return { key: fromEnv, source: '环境变量' };
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const fromFile = readKeyFromCredentials(refName, dshHome);
  if (fromFile) return { key: fromFile, source: `${dshHome}/.credentials.yaml` };
  return { key: undefined, source: null };
}

// ── 参数解析 ──────────────────────────────────────────────────
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const withHeuristic = !argv.includes('--no-heuristic');
const prompts = argv.filter((a) => !a.startsWith('--'));
const cases =
  prompts.length > 0
    ? prompts.map((text) => ({ text, why: '命令行传入' }))
    : SAMPLES;

// ── 跑 ────────────────────────────────────────────────────────
const refName = process.env.JEV_KEY_REF || 'TYPESAFE_API_KEY';
const { key, source } = resolveApiKey(refName);

if (!key) {
  console.error('✗ 找不到 TypeSafe API Key。');
  console.error(`  已尝试：环境变量 ${refName} / TYPESAFE_API_KEY / TYPESAFE_KEY，`);
  console.error(`  以及 $DSH_HOME/.credentials.yaml 的 refs.${refName}`);
  console.error('  申请：https://console.typesafe.ai（Key 只在创建时显示一次）');
  process.exit(2);
}

const client = new JevClient({ apiKey: key, timeoutMs: 15000 });
const questions = buildQuestions();

function displayWidth(text) {
  // 中文/全角按两个字符宽度算，保证表格对齐
  let w = 0;
  for (const ch of text) w += /[\u2E80-\uFFFF]/.test(ch) ? 2 : 1;
  return w;
}

function pad(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** 按显示宽度截断——用字符数判断会让长中文行撑破表格。 */
function clip(text, width) {
  if (displayWidth(text) <= width) return text;
  let w = 0;
  let out = '';
  for (const ch of text) {
    const cw = /[\u2E80-\uFFFF]/.test(ch) ? 2 : 1;
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

if (!asJson) {
  console.log('');
  console.log(`Jev 判定评测 · 凭据来源：${source} · 模型别名：jev-latest`);
  console.log('─'.repeat(112));
  console.log(
    pad('消息', 44) +
      pad('Jev', 7) +
      pad('置信度', 9) +
      pad('risk', 7) +
      pad('urgent', 8) +
      pad('耗时', 9) +
      (withHeuristic ? '关键词表' : ''),
  );
  console.log('─'.repeat(112));
}

const results = [];
for (const item of cases) {
  const started = Date.now();
  const body = await client.ask({ user_message: item.text }, questions);
  const elapsed = Date.now() - started;
  const parsed = body ? parseDecision(body) : null;
  const heuristic = heuristicEffort(item.text, 'high');

  const row = {
    text: item.text,
    why: item.why,
    jev: parsed?.effort ?? null,
    jevModel: parsed?.jevModel ?? null,
    confidence: parsed?.effortConfidence ?? null,
    risk: parsed?.risk ?? null,
    urgent: parsed?.urgent ?? null,
    latencyMs: elapsed,
    heuristic: heuristic.effort,
    error: body ? null : 'Jev 调用失败或超时',
  };
  results.push(row);

  if (!asJson) {
    console.log(
      pad(clip(item.text, 42), 44) +
        pad(row.jev ?? '—', 7) +
        pad(row.confidence === null ? '—' : row.confidence.toFixed(2), 9) +
        pad(row.risk === null ? '—' : row.risk.toFixed(2), 7) +
        pad(row.urgent === null ? '—' : row.urgent.toFixed(2), 8) +
        pad(`${elapsed}ms`, 9) +
        (withHeuristic ? row.heuristic : ''),
    );
  }
}

if (asJson) {
  console.log(JSON.stringify({ credentialSource: source, model: results[0]?.jevModel ?? null, results }, null, 2));
  process.exit(0);
}

// ── 小结 ──────────────────────────────────────────────────────
const ok = results.filter((r) => r.jev !== null);
const disagreements = results.filter((r) => r.jev !== null && r.jev !== r.heuristic);
const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);

console.log('─'.repeat(112));
console.log(`成功判定：${ok.length}/${results.length}` + (ok[0]?.jevModel ? ` · 实际版本：${ok[0].jevModel}` : ''));
if (latencies.length > 0) {
  console.log(
    `耗时：中位 ${latencies[Math.floor(latencies.length / 2)]}ms · 最快 ${latencies[0]}ms · 最慢 ${latencies[latencies.length - 1]}ms`,
  );
}
if (withHeuristic) {
  console.log(`与关键词表不一致：${disagreements.length}/${ok.length} 条`);
  for (const d of disagreements) {
    console.log(`  · Jev=${d.jev}  关键词=${d.heuristic}  ← ${d.text}`);
  }
  if (disagreements.length === 0) {
    console.log('  （本批消息未体现差异——试试带否定句的样例：--no-heuristic 关掉对比可只看 Jev）');
  }
}
console.log('');
console.log(`可用档位：${EFFORTS.join(' / ')} —— 判定结果还会经过迟滞、置信度门与降档连续确认才真正生效。`);
console.log('');
