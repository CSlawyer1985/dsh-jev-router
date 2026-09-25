import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EFFORTS,
  buildQuestions,
  parseDecision,
  heuristicEffort,
  extractUserText,
} from '../lib/classify.js';

test('EFFORTS 与 DSH DeepSeek 适配器支持的集合一致', () => {
  // 该集合来自适配器源码：z.union(["off","low","high","max"]) 与运行时白名单校验。
  assert.deepEqual([...EFFORTS], ['off', 'low', 'high', 'max']);
});

test('buildQuestions: 三种原语齐备且 instructions/criteria 为英文', () => {
  const questions = buildQuestions();
  assert.equal(questions.effort.type, 'choice');
  assert.equal(questions.risk.type, 'score');
  assert.equal(questions.urgent.type, 'noul');

  // 官方限制：CJK 准确率较低，故 instructions 必须英文。
  assert.ok(!/[\u4e00-\u9fff]/.test(questions.effort.instructions));
  assert.deepEqual(Object.keys(questions.effort.criteria).sort(), ['high', 'low', 'max', 'off']);

  // score 等级必须在 2..10 之间（官方约束）
  assert.ok(questions.risk.criteria.length >= 2 && questions.risk.criteria.length <= 10);
});

test('parseDecision: 解析真实 systemone 响应形状', () => {
  const body = {
    model: 'jev-1.13.0',
    answers: {
      effort: { type: 'choice', choice: 'high', probabilities: { high: 0.91, low: 0.09 }, confidence: 0.91 },
      risk: { type: 'score', score: 2.4, probabilities: {}, confidence: 0.8 },
      urgent: { type: 'noul', noul: 0.12 },
    },
    usage: { input_tokens: 360, output_tokens: 39 },
  };
  const parsed = parseDecision(body);
  assert.equal(parsed.effort, 'high');
  assert.equal(parsed.effortConfidence, 0.91);
  assert.equal(parsed.risk, 2.4);
  assert.equal(parsed.urgent, 0.12);
  assert.equal(parsed.jevModel, 'jev-1.13.0', '顶层 model 是作答的 Jev 版本号');
  assert.equal(parsed.model, null, '没有 answers.model 时路由目标必须为 null，绝不能回落成版本号');
});

test('parseDecision: 顶层版本号与路由目标是两个字段（混淆会让 Tier B 静默失效）', () => {
  const parsed = parseDecision({
    model: 'jev-1.13.0',
    answers: {
      effort: { type: 'choice', choice: 'high', confidence: 0.9 },
      model: { type: 'choice', choice: 'deepseek-v4-pro', probabilities: { keep: 0.1, 'deepseek-v4-pro': 0.9 }, confidence: 0.9 },
    },
  });
  assert.equal(parsed.jevModel, 'jev-1.13.0');
  assert.equal(parsed.model, 'deepseek-v4-pro', '路由目标必须来自 answers.model.choice');
  assert.notEqual(parsed.model, parsed.jevModel);
});

test('parseDecision: 非法档位与缺失字段一律安全降级', () => {
  assert.equal(parseDecision({ answers: { effort: { choice: 'ludicrous' } } }).effort, null);
  assert.equal(parseDecision({}).effortConfidence, 0);
  assert.equal(parseDecision(null).effort, null);
  assert.equal(parseDecision({ answers: { effort: { choice: 'low', confidence: 5 } } }).effortConfidence, 1);
});

test('heuristicEffort: 抄 Claude Code 的关键词表', () => {
  assert.equal(heuristicEffort('ultrathink this problem').effort, 'max');
  assert.equal(heuristicEffort('please think harder about this').effort, 'high');
  assert.equal(heuristicEffort('完整全量思考一下').effort, 'max');
  assert.equal(heuristicEffort('你好').effort, 'off');
  assert.equal(heuristicEffort('随便问一句', 'high').effort, 'high');
});

test('heuristicEffort: 快速意图优先于高强度关键词（语义反转的已知缺陷）', () => {
  // 「请快速回答完整全量思考」同时命中两类关键词。Jev 能正确判 low；
  // 回退路径按快速意图优先，这是有意的保守选择并在文档中承认。
  assert.equal(heuristicEffort('请快速回答完整全量思考').effort, 'low');
});

test('extractUserText: 只取文本块，忽略图片与文件', () => {
  assert.equal(extractUserText({ content: 'hello' }), 'hello');
  assert.equal(
    extractUserText({
      content: [
        { type: 'text', text: '第一段' },
        { type: 'image', attachment: { attachmentId: 'x' } },
        { type: 'text', text: '第二段' },
      ],
    }),
    '第一段\n第二段',
  );
  assert.equal(extractUserText({ content: [{ type: 'image' }] }), '');
  assert.equal(extractUserText(null), '');
});
