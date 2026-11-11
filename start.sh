#!/usr/bin/env bash
#
# MiMo Web UI launcher.
#
#   ./start.sh [工作目录]      # 缺省沿用上次的工作目录
#
# 一条命令搞定三件事：
#   1. 从 macOS 钥匙链注入 MIMO_API_KEY（MiMo Code 靠 {env:...} 插值取用）
#   2. 起 mimo serve（引擎绑单个工作目录；传了新目录就自动重启切过去）
#   3. 起 Web 网关并托管已构建的前端
#
# 引擎以 nohup 后台运行（Ctrl-C 只停网关，不影响下次复用）；
# Web UI 地址固定 http://127.0.0.1:5178

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

UI_PORT="${PORT:-5178}"
MIMO_PORT="${MIMO_PORT:-4096}"
KEY_SH="$HERE/scripts/mimo-key.sh"
ENGINE_SH="$HERE/scripts/mimo-engine.sh"

# 工作目录优先级：命令行参数 > 上次记录 > 当前目录
if [ $# -ge 1 ]; then
  WORKDIR="$1"
elif [ -f /tmp/mimo-serve.cwd ]; then
  WORKDIR="$(cat /tmp/mimo-serve.cwd)"
else
  WORKDIR="$PWD"
fi
WORKDIR="$(cd "$WORKDIR" 2>/dev/null && pwd -P)" || {
  echo "工作目录不存在：$1" >&2; exit 1; }

CURRENT=""
[ -f /tmp/mimo-serve.cwd ] && CURRENT="$(cat /tmp/mimo-serve.cwd)"

# ---- 1. 引擎（一实例一工作目录，换目录就重启）--------------------------------
if [ -x "$ENGINE_SH" ]; then
  if [ -n "$(lsof -nP -iTCP:"$MIMO_PORT" -sTCP:LISTEN -t 2>/dev/null)" ] && [ "$CURRENT" != "$WORKDIR" ]; then
    echo "→ 切换项目：${CURRENT} → ${WORKDIR}"
    "$ENGINE_SH" restart "$WORKDIR" || exit 1
  else
    "$ENGINE_SH" start "$WORKDIR" || exit 1
  fi
else
  echo "错误：找不到 scripts/mimo-engine.sh" >&2
  exit 1
fi

# ---- 2. 前端（首次构建）------------------------------------------------------
if [ ! -f web/dist/index.html ]; then
  echo "→ 首次构建前端…"
  npm install --no-audit --no-fund
  npm run build
fi

# ---- 3. Web 网关 -------------------------------------------------------------
if lsof -nP -iTCP:"$UI_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "→ Web UI 已在运行：http://127.0.0.1:$UI_PORT"
  echo "   换项目请重跑本脚本并传新目录"
  exit 0
fi

echo
echo "  工作目录   ${WORKDIR}"
echo "  模型       $( "$KEY_SH" status 2>/dev/null | sed -n 's/.*key: \([^ ]*\).*/\1/p' | head -1 )"
echo "  Web UI     http://127.0.0.1:$UI_PORT"
echo
echo "  换项目：./start.sh /另一个/目录"
echo "  停引擎：./scripts/mimo-engine.sh stop"
echo

exec env PORT="$UI_PORT" MIMO_UPSTREAM="http://127.0.0.1:$MIMO_PORT" node server/index.mjs
