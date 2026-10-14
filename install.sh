#!/usr/bin/env bash
# 一条命令装两个插件（DSH 防退化套件）
#
#   bash install.sh                     # 装两个（默认 profile = web）
#   bash install.sh --only guard        # 只装「折叠」
#   bash install.sh --only checkpoint   # 只装「压缩 / 换会话」
#   bash install.sh --profile headless  # 换 profile
#
# 它做的事：调用 dsh 自己的 `plugin add`（内部就是 pnpm add），
# 包声明了 dsh.bundle.patch ⇒ 包名会被自动加进 profile 的 bundles 列表。
# ⚠️ 装完必须**重启 dsh web** 才生效。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="web"
ONLY="both"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile 需要值}"; shift 2 ;;
    --only)    ONLY="${2:?--only 需要 guard 或 checkpoint}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

# 找 dsh 命令：PATH 里有就用，没有就退回本机 node 直调
echo "目标：DSH_HOME=${DSH_HOME:-$HOME/.dsh}   profile=$PROFILE"
echo
if command -v dsh >/dev/null 2>&1; then
  DSH=(dsh)
else
  BIN=""
  for c in "$HOME/dsh-linux/node_modules/@deepseek-ai/dsh/lib/bin.js" \
           /root/dsh-linux/node_modules/@deepseek-ai/dsh/lib/bin.js \
           /usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js; do
    [ -f "$c" ] && BIN="$c" && break
  done
  if [ -z "$BIN" ]; then
    echo "❌ 找不到 dsh 命令，也找不到 dsh 的 bin.js。" >&2
    echo "   请手动执行：dsh plugin --profile $PROFILE add $HERE/thinking-guard" >&2
    exit 1
  fi
  echo "ℹ️  PATH 里没有 dsh，改用 node 直调：$BIN"
  DSH=(node "$BIN")
fi

install_one() {
  local name="$1" dir="$2"
  if [ ! -d "$dir" ]; then
    echo "❌ 找不到目录：$dir" >&2
    exit 1
  fi
  echo "── 安装 $name（$dir）"
  "${DSH[@]}" plugin --profile "$PROFILE" add "$dir"
}

case "$ONLY" in
  both)       install_one "thinking-guard（折叠）"        "$HERE/thinking-guard"
              install_one "dsh-auto-checkpoint（压缩/换会话）" "$HERE/auto-checkpoint" ;;
  guard)      install_one "thinking-guard（折叠）"        "$HERE/thinking-guard" ;;
  checkpoint) install_one "dsh-auto-checkpoint（压缩/换会话）" "$HERE/auto-checkpoint" ;;
  *) echo "❌ --only 只接受 guard / checkpoint（收到：$ONLY）" >&2; exit 2 ;;
esac

echo
echo "✅ 装完了。接下来："
echo "   1) 重启 dsh web（插件是启动时加载的）"
echo "   2) 验证：${DSH[*]} --profile $PROFILE --dump-config | grep -A8 thinking-guard"
echo "   3) 想先观察不落地：编辑 thinking-guard/cordis.patch.yml，把 dryRun: true 那行取消注释，再重启"
