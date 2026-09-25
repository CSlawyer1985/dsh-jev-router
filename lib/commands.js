/**
 * /jev 命令族。
 *
 * 命令是唯一「进入会话流并留下痕迹」的通道：DSH 会为每次命令执行自动追加
 * command/run 与 command/done 事件，因此判定记录是可审计的，
 * 而自动改档只走 agent/request（不进 prompt 前缀，见 docs/CACHE_SAFETY.md）。
 */

import { EFFORTS } from './classify.js';
import { AUTHOR, AUTHOR_URL } from './settings.js';
import { shouldAlert } from './metrics.js';

const HELP = [
  'Jev 思考强度路由 —— 命令用法：',
  '  /jev                 查看当前状态（档位、命中率、节省）',
  '  /jev effort <档位>   手动钉死：auto | off | low | high | max',
  '  /jev model <模式>    auto on | auto off | lock —— 自动模型路由（默认关闭）',
  '  /jev why             解释本轮判定为什么是这个档位',
  '  /jev rollback        把模型回滚到切换前的选择',
  '  /jev pricing         查看价目来源；/jev pricing refresh 重新从官网获取',
  '  /jev about           插件与作者信息',
].join('\n');

function pct(value) {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(2)}%`;
}

function money(value) {
  return value === null || value === undefined ? '—' : `$${value.toFixed(4)}`;
}

/**
 * 注册全部命令。
 *
 * @param {object} ctx Cordis host context
 * @param {object} runtime 插件运行时（见 lib/index.js）
 * @returns {() => void} 反注册
 */
export function registerCommands(ctx, runtime) {
  const commands = ctx.get('commands');
  if (!commands?.register) return () => {};
  const disposers = [];

  disposers.push(
    commands.register({
      name: 'jev',
      description: 'Jev 思考强度路由：状态 / 手动档位 / 模型路由 / 回滚 / 价目',
      input: { hint: '[effort <档位>|model <模式>|why|rollback|pricing [refresh]|about]' },
      handler: async ({ agent, rawInput }) => {
        const input = String(rawInput ?? '').trim();
        const [verb, ...rest] = input.split(/\s+/).filter(Boolean);
        const arg = rest.join(' ').trim();

        try {
          switch ((verb ?? 'status').toLowerCase()) {
            case 'status':
              return { kind: 'success', text: runtime.describeStatus(agent) };

            case 'effort': {
              if (!arg) {
                return {
                  kind: 'error',
                  text: `当前档位：${runtime.currentEffort(agent) ?? 'harness 默认'}\n可选：auto | ${EFFORTS.join(' | ')}`,
                };
              }
              if (arg !== 'auto' && !EFFORTS.includes(arg)) {
                return { kind: 'error', text: `不认识的档位「${arg}」。可选：auto | ${EFFORTS.join(' | ')}` };
              }
              const result = await runtime.setConfig({ effort: arg });
              if (!result.ok) return { kind: 'error', text: result.reason };
              return {
                kind: 'success',
                text:
                  arg === 'auto'
                    ? '思考强度已交回 Jev 自动判定。'
                    : `思考强度已钉死为 ${arg}（手动值压过自动判定）。`,
              };
            }

            case 'model': {
              const mode = arg.toLowerCase();
              if (mode === 'auto on') {
                const result = await runtime.setConfig({ modelRouting: true });
                if (!result.ok) return { kind: 'error', text: result.reason };
                const ack = await runtime.setConfig({ acknowledgeCacheRisk: true });
                if (!ack.ok) return { kind: 'error', text: ack.reason };
                return {
                  kind: 'success',
                  text: [
                    '自动模型路由已开启（仅允许在回合起点切换）。',
                    '⚠️ 缓存代价：跨模型切换会让 thinking 块的 signature 不可移植、重写会话前缀，',
                    '命中率会从 ~99% 掉到冷启动水平。可用 /jev rollback 一键回滚，',
                    '或用 /jev model auto off 关闭。',
                  ].join('\n'),
                };
              }
              if (mode === 'auto off' || mode === 'lock') {
                const result = await runtime.setConfig({ modelRouting: false });
                if (!result.ok) return { kind: 'error', text: result.reason };
                return { kind: 'success', text: '自动模型路由已关闭，模型在整段会话内锁定。' };
              }
              const status = runtime.status(agent);
              return {
                kind: 'error',
                text: [
                  `自动模型路由：${status.modelRouting ? '开启' : '关闭（默认）'}`,
                  `已确认缓存风险：${status.acknowledgeCacheRisk ? '是' : '否'}`,
                  '用法：/jev model auto on | auto off | lock',
                ].join('\n'),
              };
            }

            case 'why':
              return { kind: 'success', text: runtime.explain(agent) };

            case 'rollback': {
              const result = runtime.rollback(agent);
              return result.ok
                ? { kind: 'success', text: `已回滚模型到 ${result.to}。` }
                : { kind: 'error', text: result.reason };
            }

            case 'pricing': {
              if (arg.toLowerCase() === 'refresh') {
                const result = await runtime.refreshPricing();
                return {
                  kind: 'success',
                  text: result.ok
                    ? `价目已从官网刷新（${result.models} 个模型）。`
                    : `官网获取失败，继续使用${result.fallback}。原因：${result.reason}`,
                };
              }
              return { kind: 'success', text: await runtime.describePricing() };
            }

            case 'about':
              return {
                kind: 'success',
                text: [
                  'dsh-jev-router v0.1.0',
                  `作者：${AUTHOR} · ${AUTHOR_URL}`,
                  '决策模型：Jev（TypeSafe AI System One）— https://typesafe.ai',
                  '缓存安全设计：默认只调思考强度；模型路由默认关闭 + 硬门禁 + 回滚。',
                  '设计原则：判定永不进入 prompt 前缀。',
                ].join('\n'),
              };

            default:
              return { kind: 'error', text: HELP };
          }
        } catch (error) {
          return { kind: 'error', text: `jev 命令失败：${String(error?.message ?? error)}` };
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

export const __test__ = { pct, money, HELP };
