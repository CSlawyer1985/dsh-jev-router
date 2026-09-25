#!/usr/bin/env bash
# dsh-jev-router 安装自检
#
# 用途：DSH 重启之后跑一遍，确认插件真的可用。
# 退出码：0 = 全部通过（跳过项不计失败）；1 = 有项目失败。
#
# 用法：bash scripts/verify-install.sh [GUI_URL] [TOKEN]
#   GUI_URL 默认 $DSH_WEB_URL，其次 http://127.0.0.1:19387
#   TOKEN   dsh web 启动时打印的 ?token=…（前端半检查需要它）
#
# 为什么前端半需要 token：client 模块打成合并包，必须先读首页的 __DSH_BOOT__
# 才能拿到包 URL，而首页要求认证。没有 token 时这一项标记为「跳过」。

set -uo pipefail

URL="${1:-${DSH_WEB_URL:-http://127.0.0.1:19387}}"
TOKEN="${2:-}"
JAR="$(mktemp -t jev-jar.XXXXXX)"
INDEX="$(mktemp -t jev-index.XXXXXX)"
BUNDLE="$(mktemp -t jev-bundle.XXXXXX)"
trap 'rm -f "$JAR" "$INDEX" "$BUNDLE"' EXIT

PASS=0
FAIL=0
SKIP=0

ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
bad()   { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
skip()  { printf '  \033[33m·\033[0m %s\n' "$1"; SKIP=$((SKIP + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

head_ "1. 目标"
echo "  GUI: $URL"
if [ -n "$TOKEN" ]; then echo "  token: 已提供"; else echo "  token: 未提供（前端半检查将跳过）"; fi

# ── 2. Host 半 ──────────────────────────────────────────────
head_ "2. Host 半：状态路由必须返回完整快照"
STATUS_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$URL/jev-router/status" 2>/dev/null)"
STATUS_BODY="$(curl -s --max-time 8 "$URL/jev-router/status" 2>/dev/null)"

if [ "$STATUS_CODE" = "200" ]; then ok "HTTP 200"; else bad "HTTP $STATUS_CODE（插件未加载？确认已重启 DSH）"; fi

if [ "$STATUS_BODY" = "{}" ] || [ -z "$STATUS_BODY" ]; then
  bad "返回了空对象 —— 未 await async 方法的症状，说明跑的是旧模块"
else
  ok "返回了非空快照"
fi

# 子检查：body 通过环境变量交给 python，避免与 stdin 抢管道。
if command -v python3 >/dev/null 2>&1 && [ -n "$STATUS_BODY" ]; then
  SUB_OUT="$(STATUS_BODY="$STATUS_BODY" python3 -c '
import json, os, sys

try:
    d = json.loads(os.environ["STATUS_BODY"])
except Exception as exc:
    print("  \033[31m✗\033[0m 不是合法 JSON: %s" % exc)
    print("##SUB 0 1")
    sys.exit(0)

cfg = d.get("config") or {}
checks = [
    ("author == chenshi.ai", d.get("author") == "chenshi.ai"),
    ("config / metrics / pricing 快照齐备",
     all(isinstance(d.get(k), dict) for k in ("config", "metrics", "pricing"))),
    ("Tier B 默认关闭", cfg.get("modelRouting") is False),
    ("缓存风险默认未确认（硬门禁）", cfg.get("acknowledgeCacheRisk") is False),
    ("effort 是裸值而非 volatile 包装", isinstance(cfg.get("effort"), str)),
    ("hitRateAlert 是裸数字", isinstance(cfg.get("hitRateAlert"), (int, float))),
]
bad = 0
for name, good in checks:
    print("  %s %s" % ("\033[32m✓\033[0m" if good else "\033[31m✗\033[0m", name))
    bad += 0 if good else 1
print("  ·  命中率: %s   价目来源: %s"
      % (d.get("metrics", {}).get("hitRate"), d.get("pricing", {}).get("source")))
print("##SUB %d %d" % (len(checks) - bad, bad))
' 2>/dev/null)"

  printf '%s\n' "$SUB_OUT" | grep -v '^##SUB'
  TALLY="$(printf '%s\n' "$SUB_OUT" | grep '^##SUB' | tail -1)"
  if [ -n "$TALLY" ]; then
    # shellcheck disable=SC2086
    set -- $TALLY
    PASS=$((PASS + ${2:-0}))
    FAIL=$((FAIL + ${3:-0}))
  else
    FAIL=$((FAIL + 1))
  fi
fi

# ── 3. 写入路由的同源门禁 ───────────────────────────────────
head_ "3. 写入路由：跨站来源必须被拒（403）"
FORBIDDEN="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
  -X POST -H 'content-type: application/json' -H 'Origin: https://evil.example' \
  -d '{"patch":{}}' "$URL/jev-router/config" 2>/dev/null)"
if [ "$FORBIDDEN" = "403" ]; then ok "跨站写入被拒"; else bad "期望 403，实际 $FORBIDDEN"; fi

# ── 4. 价目 ─────────────────────────────────────────────────
head_ "4. 价格路由：应能从官网取回价目"
PRICING="$(curl -s --max-time 25 -X POST "$URL/jev-router/pricing/refresh" 2>/dev/null)"
case "$PRICING" in
  *'"ok":true'*)  ok "刷新成功（官网可达）" ;;
  *'"ok":false'*) ok "官网不可达，已回退快照（不影响使用）" ;;
  *)              bad "无法解析响应: $(printf '%s' "$PRICING" | head -c 120)" ;;
esac

# ── 5. 前端半 ───────────────────────────────────────────────
head_ "5. 前端半：client 模块必须被打包并交付给浏览器"
if [ -z "$TOKEN" ]; then
  skip "未提供 token，跳过（用法：bash $0 $URL <token>）"
else
  curl -sL -c "$JAR" -b "$JAR" -o "$INDEX" --max-time 12 "$URL/?token=$TOKEN" 2>/dev/null

  if ! grep -q 'dsh-jev-router' "$INDEX" 2>/dev/null; then
    bad "首页图谱里没有 dsh-jev-router —— 前端半未被打包（检查 package.json 的 dsh.client）"
  else
    ok "首页图谱 __DSH_BOOT__ 里包含 dsh-jev-router"

    # 这个版本把 client 模块打成合并包（plugins/??a/client.js,b/client.js…），
    # 没有 /plugins/<id>/client.js 这种单独路由；必须从图谱里取真实 URL。
    BUNDLE_URL="$(INDEX="$INDEX" python3 -c '
import html as H, os, re
raw = H.unescape(open(os.environ["INDEX"], encoding="utf-8", errors="replace").read())
urls = [u for u in re.findall(r"(plugins/\?\?[^\"\x27]+)", raw) if "dsh-jev-router/client.js" in u]
only = [u for u in urls if u.startswith("plugins/??dsh-jev-router/")]
print((only or urls or [""])[0])
' 2>/dev/null)"

    if [ -z "$BUNDLE_URL" ]; then
      bad "图谱里有记录，但找不到包含它的合并包 URL"
    else
      BUNDLE_CODE="$(curl -sL -c "$JAR" -b "$JAR" -o "$BUNDLE" -w '%{http_code}' --max-time 20 "$URL/$BUNDLE_URL" 2>/dev/null)"
      if [ "$BUNDLE_CODE" = "200" ] && grep -q 'chenshi.ai' "$BUNDLE" 2>/dev/null; then
        ok "合并包可加载（HTTP 200）且包含插件前端代码与署名"
      else
        bad "合并包加载失败：HTTP $BUNDLE_CODE"
      fi
    fi
  fi
fi

# ── 6. 路由不得被通配 fallback 冒充 ─────────────────────────
head_ "6. 未知路由应为 404（排除通配 fallback 冒充）"
UNKNOWN="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$URL/jev-router/__nope" 2>/dev/null)"
if [ "$UNKNOWN" = "404" ]; then ok "未知路由 404"; else bad "期望 404，实际 $UNKNOWN"; fi

printf '\n\033[1m结果：%d 通过 / %d 失败 / %d 跳过\033[0m\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ] || exit 1
