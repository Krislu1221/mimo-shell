#!/usr/bin/env bash
#
# MiMo Coding Plan 凭证管理 —— macOS 钥匙链是唯一真源。
#
#   ./scripts/mimo-key.sh save [--keep]   写入钥匙链（默认清空本仓库 .env 里的明文）
#   ./scripts/mimo-key.sh get             打印 key
#   ./scripts/mimo-key.sh env             打印 export 语句（MIMO_API_KEY / MIMO_BASE_URL）
#   ./scripts/mimo-key.sh status          看状态，不打印 key
#   ./scripts/mimo-key.sh launchctl       写进 launchd 环境，让 GUI 启动的 DSH 也能用
#   ./scripts/mimo-key.sh unset-launchctl 移除 launchd 里的变量
#   ./scripts/mimo-key.sh clear           从钥匙链删除
#
# 读取优先级（钥匙链优先，明文文件只作兜底）：
#   1. 钥匙链 service="mimo-coding-plan"
#   2. ~/.nanobot/env/mimo.env            （明文，仅兜底）
#   3. 本仓库 .env                        （明文，仅兜底 / 粘贴新 key 用）
#
# ⚠ 两套 key 不要混用：
#   tp- 开头 = Coding Plan → https://token-plan-cn.xiaomimimo.com/v1
#   sk- 开头 = 平台 key   → https://api.xiaomimimo.com/v1

set -euo pipefail

SERVICE="mimo-coding-plan"
ACCOUNT="${USER:-$(id -un)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${MIMO_ENV_FILE:-$HERE/../.env}"
NANOBOT_ENV="${NANOBOT_ENV:-$HOME/.nanobot/env/mimo.env}"
BASE_URL="${MIMO_BASE_URL:-https://token-plan-cn.xiaomimimo.com/v1}"

die() { echo "错误：$*" >&2; exit 1; }

# 钥匙链读取。该条目可能没有 account 属性（acct=NULL），
# 所以两种查法都试：带 -a 的先试，不带的后试。
read_keychain() {
  local k
  k="$(security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w 2>/dev/null || true)"
  [ -n "$k" ] && { printf '%s' "$k"; return 0; }
  k="$(security find-generic-password -s "$SERVICE" -w 2>/dev/null || true)"
  [ -n "$k" ] && { printf '%s' "$k"; return 0; }
  return 1
}

# 从任意 env 文件取值（不 source，避免执行文件内容）
env_get() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 1
  local line
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$file" | tail -n1)" || return 1
  [ -n "$line" ] || return 1
  local value="${line#*=}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

# 解析出最终要用的 key，并记录来源
resolve_key() {
  local k
  if k="$(read_keychain)"; then
    printf '%s' "$k"; KEY_SOURCE="钥匙链"; return 0
  fi
  if k="$(env_get MIMO_API_KEY "$NANOBOT_ENV")" && [ -n "$k" ]; then
    printf '%s' "$k"; KEY_SOURCE="nanobot 明文文件（兜底）"; return 0
  fi
  if k="$(env_get MIMO_API_KEY "$ENV_FILE")" && [ -n "$k" ]; then
    printf '%s' "$k"; KEY_SOURCE="本仓库 .env（明文兜底）"; return 0
  fi
  return 1
}

# tp- 是 Coding Plan，sk- 是平台 key —— 端点不同，不能混用
check_kind() {
  case "$1" in
    tp-*) return 0 ;;
    sk-*)
      echo "⚠ 这个 key 以 sk- 开头，是「平台 key」，不是 Coding Plan key。" >&2
      echo "  平台 key 的端点是 https://api.xiaomimimo.com/v1，别和 ${BASE_URL} 混用。" >&2
      ;;
    *) echo "⚠ key 前缀既不是 tp- 也不是 sk-，请确认来源。" >&2 ;;
  esac
}

case "${1:-status}" in
  save)
    key="$(env_get MIMO_API_KEY "$ENV_FILE" || true)"
    [ -n "$key" ] || die "$ENV_FILE 里没有填 MIMO_API_KEY"
    check_kind "$key"

    # -U 覆盖同名项，-A 让本机程序免弹授权框。
    # 写两份：带 account 的（便于按账号查）和不带 account 的（与已有条目同形）。
    security add-generic-password -U -A -a "$ACCOUNT" -s "$SERVICE" \
      -D "MiMo Coding Plan API key (token-plan-cn)" -w "$key" >/dev/null
    security add-generic-password -U -A -s "$SERVICE" \
      -D "MiMo Coding Plan API key (token-plan-cn)" -w "$key" >/dev/null
    echo "✓ 已写入钥匙链：service=${SERVICE}"

    if [ "${2:-}" != "--keep" ]; then
      tmp="$(mktemp)"
      grep -vE '^[[:space:]]*MIMO_API_KEY[[:space:]]*=' "$ENV_FILE" > "$tmp" || true
      printf 'MIMO_API_KEY=\n' >> "$tmp"
      cat "$tmp" > "$ENV_FILE"
      rm -f "$tmp"
      echo "✓ 已清空 ${ENV_FILE} 里的明文（需要保留请用 --keep）"
    fi
    echo "  base URL: ${BASE_URL}"

    # 让正在跑的引擎立刻用上新 key
    if [ -x "$HERE/mimo-engine.sh" ] && "$HERE/mimo-engine.sh" status 2>/dev/null | grep -q "运行中"; then
      echo "→ 重启引擎以应用新 key…"
      "$HERE/mimo-engine.sh" restart 2>&1 | sed 's/^/  /' || true
    fi
    ;;

  get)
    key="$(resolve_key)" || die "找不到 key（钥匙链 service=${SERVICE} 也没有，兜底文件里也没有）"
    printf '%s' "$key"
    ;;

  env)
    resolve_key >/dev/null || die "找不到 key（钥匙链 service=${SERVICE} 也没有，兜底文件里也没有）"
    key="$(resolve_key)"
    printf 'export MIMO_API_KEY=%q\n' "$key"
    printf 'export MIMO_BASE_URL=%q\n' "$BASE_URL"
    ;;

  launchctl)
    key="$(resolve_key)" || die "找不到 key"
    launchctl setenv MIMO_API_KEY "$key"
    launchctl setenv MIMO_BASE_URL "$BASE_URL"
    echo "✓ 已写入 launchd 环境（MIMO_API_KEY / MIMO_BASE_URL）"
    echo "  提示：从启动台/Finder 启动的 DSH 需要完全退出重开才会带上这个变量"
    ;;

  unset-launchctl)
    launchctl unsetenv MIMO_API_KEY 2>/dev/null || true
    launchctl unsetenv MIMO_BASE_URL 2>/dev/null || true
    echo "✓ 已从 launchd 环境移除 MIMO_API_KEY / MIMO_BASE_URL"
    ;;

  status)
    if k="$(read_keychain)"; then
      echo "✓ 钥匙链中有 ${SERVICE}"
      echo "  key: ${k:0:3}***  长度 ${#k}  来源: 钥匙链"
    else
      echo "✗ 钥匙链中没有 ${SERVICE}"
      if k="$(env_get MIMO_API_KEY "$NANOBOT_ENV")" && [ -n "$k" ]; then
        echo "  （兜底可用：${NANOBOT_ENV}，但那是明文文件）"
      fi
    fi
    echo "  base URL: ${BASE_URL}"
    for f in "$NANOBOT_ENV" "$ENV_FILE"; do
      [ -f "$f" ] || continue
      p="$(env_get MIMO_API_KEY "$f" || true)"
      [ -n "$p" ] && echo "  ⚠ ${f} 里有明文 key"
    done
    ;;

  clear)
    if security delete-generic-password -a "$ACCOUNT" -s "$SERVICE" >/dev/null 2>&1 \
       || security delete-generic-password -s "$SERVICE" >/dev/null 2>&1; then
      echo "✓ 已从钥匙链删除 ${SERVICE}"
    else
      echo "（钥匙链里本来就没有 ${SERVICE}）"
    fi
    ;;

  *)
    sed -n '3,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
