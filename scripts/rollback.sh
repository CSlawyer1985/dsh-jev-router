#!/usr/bin/env bash
# dsh-jev-router 一键回滚
#
# 用途：如果重启 DSH 失败（插件导致 web boot 失败），用这条命令把 profile
# 恢复到「插件禁用 + patch 完整」的状态，比应用自带的安全模式更好——
# 安全模式会顺手清掉 profile patch 里的自定义条目（曾因此丢掉
# agent-default-model 与 llm-pi-ai）。
#
# 这个脚本**不需要 DSH 在运行**，正是为「应用起不来」的场景准备的。
#
# 用法：bash scripts/rollback.sh [PROFILE_DIR]
#   默认 profile：$DSH_PROFILE_DIR，其次 ~/.dsh/profiles/desktop

set -uo pipefail

PROFILE="${1:-${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '  ·  %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

printf '\n\033[1m回滚 dsh-jev-router\033[0m\n'
info "profile: $PROFILE"
[ -d "$PROFILE" ] || die "profile 目录不存在"

TS="$(date +%s)"

# ── 1. 从 bundles 里摘掉插件（保留 link: 依赖，包不丢） ──────
PKG="$PROFILE/package.json"
if [ -f "$PKG" ]; then
  cp "$PKG" "$PKG.before-rollback-$TS"
  python3 - "$PKG" <<'PY'
import json, sys

path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)

bundles = data.get("dsh", {}).get("profile", {}).get("bundles")
if isinstance(bundles, list):
    removed = [b for b in bundles if b == "dsh-jev-router"]
    data["dsh"]["profile"]["bundles"] = [b for b in bundles if b != "dsh-jev-router"]
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    print("  \033[32m✓\033[0m 已从 bundles 移除 dsh-jev-router" if removed else "  ·  bundles 里本来就没有它")
else:
    print("  ·  package.json 没有 dsh.profile.bundles，跳过")
PY
  info "package.json 备份 → $(basename "$PKG").before-rollback-$TS"
else
  info "没有 package.json，跳过"
fi

# ── 2. 恢复 profile patch（优先用未被精简过的备份） ──────────
PATCH="$PROFILE/cordis.patch.yml"
if [ -f "$PATCH" ]; then
  cp "$PATCH" "$PATCH.before-rollback-$TS"
  CANDIDATE=""
  # 选条目最多的那个备份：条目被安全模式精简过时，条目多的才是完好的
  for f in "$PROFILE"/cordis.patch.yml.bak-*; do
    [ -f "$f" ] || continue
    if [ -z "$CANDIDATE" ] || [ "$(grep -cE '^- id:' "$f")" -gt "$(grep -cE '^- id:' "$CANDIDATE")" ]; then
      CANDIDATE="$f"
    fi
  done
  if [ -n "$CANDIDATE" ]; then
    cp "$CANDIDATE" "$PATCH"
    ok "patch 已从 $(basename "$CANDIDATE") 恢复（$(grep -cE '^- id:' "$PATCH") 条）"
  else
    info "没有找到 patch 备份，保持现状"
  fi
  info "patch 备份 → $(basename "$PATCH").before-rollback-$TS"
else
  info "没有 cordis.patch.yml，跳过"
fi

printf '\n\033[1m完成\033[0m\n'
info "下一步：重新打开 DeepSeek Harness（此时插件已禁用，应当能正常启动）"
info "排查完再启用：在「设置 → 插件」打开 dsh-jev-router，或跑"
info "  dsh plugin enable dsh-jev-router"
printf '\n'
